#include "lt100/calibration.h"

#include <cmath>
#include <cstring>

namespace lt100 {
namespace {

constexpr float kDegreesPerTick = 360.0f / 4096.0f;

bool finite(float v) {
  return v > -1.0e6f && v < 1.0e6f;
}

uint32_t mixByte(uint32_t h, uint8_t b) {
  h ^= b;
  h *= 16777619u;
  return h;
}

uint32_t mixU16(uint32_t h, uint16_t v) {
  h = mixByte(h, static_cast<uint8_t>(v & 0xff));
  h = mixByte(h, static_cast<uint8_t>((v >> 8) & 0xff));
  return h;
}

uint32_t mixU32(uint32_t h, uint32_t v) {
  h = mixByte(h, static_cast<uint8_t>(v & 0xff));
  h = mixByte(h, static_cast<uint8_t>((v >> 8) & 0xff));
  h = mixByte(h, static_cast<uint8_t>((v >> 16) & 0xff));
  h = mixByte(h, static_cast<uint8_t>((v >> 24) & 0xff));
  return h;
}

uint32_t mixFloat(uint32_t h, float v) {
  uint32_t bits = 0;
  std::memcpy(&bits, &v, sizeof(bits));
  return mixU32(h, bits);
}

}  // namespace

bool calibrationJointValid(const JointCalibration& j) {
  if (!j.hasRef || !j.hasMin || !j.hasMax) return false;
  if (j.sign != 1 && j.sign != -1) return false;
  if (j.zeroRaw < kRawMin || j.zeroRaw > kRawMax) return false;
  if (j.minRaw < kRawMin || j.minRaw > kRawMax) return false;
  if (j.maxRaw < kRawMin || j.maxRaw > kRawMax) return false;
  if (j.minRaw >= j.maxRaw) return false;
  if (j.margin == 0 || j.margin > 512) return false;
  if (j.maxRaw - j.minRaw <= 2 * static_cast<int>(j.margin)) return false;
  if (!finite(j.zeroQ)) return false;
  const int safeMin = static_cast<int>(j.minRaw) + static_cast<int>(j.margin);
  const int safeMax = static_cast<int>(j.maxRaw) - static_cast<int>(j.margin);
  if (j.zeroRaw < safeMin || j.zeroRaw > safeMax) return false;
  return true;
}

bool calibrationValidate(const Calibration& cal) {
  if (cal.version != 1) return false;
  for (uint8_t i = 0; i < kJointCount; i++) {
    const JointCalibration& j = cal.joint[i];
    if (!j.hasRef && !j.hasMin && !j.hasMax) continue;
    if (j.sign != 1 && j.sign != -1) return false;
    if (j.zeroRaw < kRawMin || j.zeroRaw > kRawMax) return false;
    if (!finite(j.zeroQ)) return false;
    if (j.margin == 0 || j.margin > 512) return false;
    if (j.hasMin && (j.minRaw < kRawMin || j.minRaw > kRawMax)) return false;
    if (j.hasMax && (j.maxRaw < kRawMin || j.maxRaw > kRawMax)) return false;
    if (j.hasMin && j.hasMax) {
      if (j.minRaw >= j.maxRaw) return false;
      if (j.maxRaw - j.minRaw <= 2 * static_cast<int>(j.margin)) return false;
    }
    if (j.hasRef && j.hasMin && j.hasMax && !calibrationJointValid(j)) {
      return false;
    }
  }
  return true;
}

bool calibrationComplete(const Calibration& cal) {
  for (uint8_t i = 0; i < kJointCount; i++) {
    if (!calibrationJointValid(cal.joint[i])) return false;
  }
  return true;
}

uint8_t calibrationValidMask(const Calibration& cal) {
  uint8_t mask = 0;
  for (uint8_t i = 0; i < kJointCount; i++) {
    if (calibrationJointValid(cal.joint[i])) mask |= static_cast<uint8_t>(1u << i);
  }
  return mask;
}

uint16_t calibrationChecksum(const Calibration& cal) {
  uint32_t h = 2166136261u;
  h = mixByte(h, cal.version);
  for (uint8_t i = 0; i < kJointCount; i++) {
    const JointCalibration& j = cal.joint[i];
    h = mixByte(h, j.hasRef ? 1 : 0);
    h = mixByte(h, j.hasMin ? 1 : 0);
    h = mixByte(h, j.hasMax ? 1 : 0);
    h = mixByte(h, static_cast<uint8_t>(j.sign));
    h = mixU16(h, static_cast<uint16_t>(j.zeroRaw));
    h = mixFloat(h, j.zeroQ);
    h = mixU16(h, static_cast<uint16_t>(j.minRaw));
    h = mixU16(h, static_cast<uint16_t>(j.maxRaw));
    h = mixU16(h, j.margin);
  }
  return static_cast<uint16_t>((h ^ (h >> 16)) & 0xffffu);
}

void calibrationSetChecksum(Calibration& cal) {
  cal.checksum = calibrationChecksum(cal);
}

float rawToQ(const JointCalibration& joint, int16_t raw) {
  return joint.zeroQ + static_cast<float>(joint.sign) *
                           static_cast<float>(raw - joint.zeroRaw) * kDegreesPerTick;
}

bool qToRaw(const JointCalibration& joint, float q, int16_t& raw) {
  if (!calibrationJointValid(joint)) return false;
  if (!finite(q)) return false;
  const float value = static_cast<float>(joint.zeroRaw) +
                      static_cast<float>(joint.sign) * (q - joint.zeroQ) * kTicksPerDegree;
  const long rounded = std::lround(value);
  if (rounded < kRawMin || rounded > kRawMax) return false;
  raw = static_cast<int16_t>(rounded);
  return true;
}

}  // namespace lt100
