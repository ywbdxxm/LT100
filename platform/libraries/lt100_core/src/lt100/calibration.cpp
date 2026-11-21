#include "lt100/calibration.h"

#include <cmath>
#include <cstring>

namespace lt100 {
namespace {

constexpr float kDegreesPerTick = 360.0f / 4096.0f;
constexpr int kRawCount = 4096;

int normalizeRaw(int value) {
  value %= kRawCount;
  if (value < 0) value += kRawCount;
  return value;
}

int circularDistance(int from, int to) {
  return normalizeRaw(to - from);
}

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

int calibrationSpanTicks(const JointCalibration& j) {
  return circularDistance(j.minRaw, j.maxRaw);
}

int16_t safeStartRaw(const JointCalibration& j) {
  return static_cast<int16_t>(
      normalizeRaw(static_cast<int>(j.minRaw) + static_cast<int>(j.margin)));
}

int16_t safeEndRaw(const JointCalibration& j) {
  return static_cast<int16_t>(
      normalizeRaw(static_cast<int>(j.minRaw) +
                   calibrationSpanTicks(j) - static_cast<int>(j.margin)));
}

bool rawInJointRange(const JointCalibration& j, int raw) {
  const int span = calibrationSpanTicks(j);
  if (span <= 0) return false;
  return circularDistance(j.minRaw, raw) <= span;
}

bool rawInSafeRange(const JointCalibration& j, int raw) {
  const int span = calibrationSpanTicks(j);
  const int margin = static_cast<int>(j.margin);
  if (span <= 2 * margin) return false;
  const int distance = circularDistance(j.minRaw, raw);
  return distance >= margin && distance <= span - margin;
}

void calibrationOrientEndpoints(JointCalibration& j) {
  if (!j.hasRef || !j.hasMin || !j.hasMax) return;
  if (j.minRaw == j.maxRaw) return;
  const int span = calibrationSpanTicks(j);
  if (circularDistance(j.minRaw, j.zeroRaw) > span) {
    const int16_t start = j.minRaw;
    j.minRaw = j.maxRaw;
    j.maxRaw = start;
  }
}

bool calibrationJointValid(const JointCalibration& j) {
  if (!j.hasRef || !j.hasMin || !j.hasMax) return false;
  if (j.sign != 1 && j.sign != -1) return false;
  if (j.zeroRaw < kRawMin || j.zeroRaw > kRawMax) return false;
  if (j.minRaw < kRawMin || j.minRaw > kRawMax) return false;
  if (j.maxRaw < kRawMin || j.maxRaw > kRawMax) return false;
  if (j.minRaw == j.maxRaw) return false;
  if (j.margin == 0 || j.margin > 512) return false;
  if (calibrationSpanTicks(j) <= 2 * static_cast<int>(j.margin)) return false;
  if (!finite(j.zeroQ)) return false;
  if (!rawInSafeRange(j, j.zeroRaw)) return false;
  return true;
}

bool calibrationJointUsable(const JointCalibration& j) {
  return calibrationJointValid(j) && j.minRaw <= j.maxRaw;
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
      if (j.minRaw == j.maxRaw) return false;
      if (calibrationSpanTicks(j) <= 2 * static_cast<int>(j.margin)) return false;
    }
    if (j.hasRef && j.hasMin && j.hasMax && !calibrationJointValid(j)) {
      return false;
    }
  }
  return true;
}

bool calibrationComplete(const Calibration& cal) {
  for (uint8_t i = 0; i < kJointCount; i++) {
    if (!calibrationJointUsable(cal.joint[i])) return false;
  }
  return true;
}

uint8_t calibrationValidMask(const Calibration& cal) {
  uint8_t mask = 0;
  for (uint8_t i = 0; i < kJointCount; i++) {
    if (calibrationJointUsable(cal.joint[i])) mask |= static_cast<uint8_t>(1u << i);
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

// Map along the calibrated arc (minRaw -> maxRaw), not the shortest arc, so
// travels beyond 180 degrees stay unambiguous.
float rawToQ(const JointCalibration& joint, int16_t raw) {
  const int span = calibrationSpanTicks(joint);
  if (span <= 0) {
    return joint.zeroQ + static_cast<float>(joint.sign) *
                             static_cast<float>(raw - joint.zeroRaw) * kDegreesPerTick;
  }
  const int zeroOnArc = circularDistance(joint.minRaw, joint.zeroRaw);
  const int rawOnArc = circularDistance(joint.minRaw, raw);
  return joint.zeroQ + static_cast<float>(joint.sign) *
                           static_cast<float>(rawOnArc - zeroOnArc) * kDegreesPerTick;
}

// Pure conversion along the calibrated arc; range checking belongs to the
// caller (checkPose / handleJog check q against the safe q interval).
bool qToRaw(const JointCalibration& joint, float q, int16_t& raw) {
  if (!calibrationJointValid(joint)) return false;
  if (!finite(q)) return false;
  const int zeroOnArc = circularDistance(joint.minRaw, joint.zeroRaw);
  const float onArc = static_cast<float>(zeroOnArc) +
                      static_cast<float>(joint.sign) * (q - joint.zeroQ) * kTicksPerDegree;
  const long rounded = std::lround(static_cast<float>(joint.minRaw) + onArc);
  raw = static_cast<int16_t>(normalizeRaw(static_cast<int>(rounded)));
  return true;
}

}  // namespace lt100
