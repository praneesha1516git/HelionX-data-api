import mongoose from "mongoose";
import dotenv from "dotenv";
import { connectDB } from "./db";
import { EnergyGenerationRecord } from "./entities/EnergyGenerationRecord";

dotenv.config();

// Local Anomaly schema for seeding in data-api
const anomalySchema = new mongoose.Schema({
  solarUnitId: { type: mongoose.Schema.Types.ObjectId, required: true },
  anomalyType: String,
  anomayName: String, // keep spelling consistent with backend schema
  severity: { type: String, enum: ["LOW", "MEDIUM", "HIGH"] },
  detectionTimestamp: { type: Date, default: Date.now },
  description: String,
  resolvedStatus: { type: Boolean, default: false },
});
const Anomaly = mongoose.model("Anomaly", anomalySchema);

// Minimal SolarUnit model to pull active units from the shared DB
const solarUnitSchema = new mongoose.Schema({
  serialNumber: String,
  installationDate: Date,
  status: String,
});
const SolarUnit = mongoose.model("SolarUnit", solarUnitSchema);

const TARGET_UNITS = [
  { id: "69429dae69955f96250c3b65", serialNumber: "SU-0001", installationDate: "2025-07-01" },
  { id: "694396a9e2f65da567777e4d", serialNumber: "SU-0002", installationDate: "2025-07-15" },
  { id: "69456862376c9857e36090ac", serialNumber: "SU-0003", installationDate: "2025-08-01" },
];

const anomalyGroups = [
  { type: "Point Anomaly", names: ["Sudden Energy Spike", "Sudden Energy Drop"] },
  { type: "Contextual Anomaly", names: ["Night-Time Energy Generation"] },
  { type: "Collective Anomaly", names: ["Flat-Line Pattern", "Missing Noon Peak"] },
  { type: "Data Quality Anomaly", names: ["Missing Interval Records", "Duplicate Interval Records"] },
];
const severities: ("LOW" | "MEDIUM" | "HIGH")[] = ["LOW", "MEDIUM", "HIGH"];

const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];

const makeEnergyValue = (d: Date) => {
  const hour = d.getUTCHours();
  const month = d.getUTCMonth();
  let base = 5;
  if (month >= 5 && month <= 7) base = 6;
  else if (month >= 2 && month <= 4) base = 5.5;
  else if (month >= 8 && month <= 10) base = 5;
  else base = 4.5;

  let mult = 0;
  if (hour >= 6 && hour < 18) {
    mult = 1.2;
    if (hour >= 10 && hour < 14) mult = 1.5;
  }
  const variation = 0.8 + Math.random() * 0.4;
  return Math.max(0, Math.round(base * mult * variation));
};

async function seed() {
  try {
    await connectDB();
    await EnergyGenerationRecord.deleteMany({});
    await Anomaly.deleteMany({});

    let totalEnergy = 0;
    let totalAnomalies = 0;

    // Try to use live active solar units; fallback to defaults if none
    const liveUnits = await SolarUnit.find({ status: "ACTIVE" })
      .select({ _id: 1, serialNumber: 1, installationDate: 1 })
      .lean();
    const units = liveUnits?.length
      ? liveUnits.map((u) => ({
          id: u._id.toString(),
          serialNumber: u.serialNumber || "N/A",
          installationDate: u.installationDate || new Date().toISOString(),
        }))
      : TARGET_UNITS;

    for (const unit of units) {
      const unitId = new mongoose.Types.ObjectId(unit.id);
      const startDate = new Date(unit.installationDate);
      const endDate = new Date();

      // Energy records every 2 hours
      const energyRecords: any[] = [];
      const anomalySlotsPerDay: Record<string, number> = {};
      for (
        let t = new Date(startDate);
        t <= endDate;
        t = new Date(t.getTime() + 2 * 60 * 60 * 1000)
      ) {
        const dayKey = t.toISOString().slice(0, 10);
        const countToday = anomalySlotsPerDay[dayKey] || 0;
        const shouldMarkAnomaly = countToday < 10 && Math.random() < 0.2; // up to 10/day
        if (shouldMarkAnomaly) {
          anomalySlotsPerDay[dayKey] = countToday + 1;
        }
        energyRecords.push({
          solarUnitId: unitId, // stored even if schema ignores; serial used for legacy
          serialNumber: unit.serialNumber,
          timestamp: t,
          energyGenerated: makeEnergyValue(t),
          intervalHours: 2,
          hasAnomaly: shouldMarkAnomaly,
          anomalyType: shouldMarkAnomaly ? pick(anomalyGroups).type : undefined,
        });
      }
      if (energyRecords.length) {
        await EnergyGenerationRecord.insertMany(energyRecords);
        totalEnergy += energyRecords.length;
      }

      // Anomalies per unit: walk each day from installation -> now
      // 0–5 anomalies per day, cap to avoid huge volume
      const anomalies: any[] = [];
      const totalTarget = 60;
      for (
        let d = new Date(startDate);
        d <= endDate && anomalies.length < totalTarget;
        d = new Date(d.getTime() + 24 * 60 * 60 * 1000)
      ) {
        const dateKey = d.toISOString().slice(0, 10);
        const countToday = Math.min(5, Math.floor(Math.random() * 6)); // 0–5 per day
        const slots = [6, 9, 12, 15, 18]; // UTC hours to space within the day
        for (let i = 0; i < countToday && anomalies.length < totalTarget; i++) {
          const group = pick(anomalyGroups);
          const name = pick(group.names);
          const ts = new Date(`${dateKey}T${String(slots[i]).padStart(2, "0")}:00:00Z`);
          anomalies.push({
            solarUnitId: unitId,
            anomalyType: group.type,
            anomayName: name,
            severity: pick(severities),
            detectionTimestamp: ts,
            description: `Seeded ${name} at ${ts.toISOString()}`,
            resolvedStatus: Math.random() < 0.3,
          });
        }
      }
      if (anomalies.length) {
        await Anomaly.insertMany(anomalies);
        totalAnomalies += anomalies.length;
      }
    }

    console.log(
      `Seed complete. Energy records: ${totalEnergy}, Anomalies: ${totalAnomalies}.`
    );
  } catch (err) {
    console.error("Seeding error:", err);
  } finally {
    await mongoose.disconnect();
  }
}

seed();
