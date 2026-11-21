#include "lt100/limits.h"

namespace lt100 {

Error checkMotionParams(uint16_t speed, uint8_t acc) {
  if (speed == 0 || speed > kMaxSpeed) return Error::Range;
  if (acc > kMaxAcc) return Error::Range;
  return Error::None;
}

Error checkPose(const Calibration& cal, const Pose& pose, uint16_t speed, uint8_t acc,
                int16_t raw[kJointCount]) {
  const Error params = checkMotionParams(speed, acc);
  if (params != Error::None) return params;
  if (!calibrationComplete(cal)) return Error::Uncalibrated;

  for (uint8_t i = 0; i < kJointCount; i++) {
    int16_t target = 0;
    if (!qToRaw(cal.joint[i], pose.q[i], target)) return Error::Range;
    const JointCalibration& j = cal.joint[i];
    const int safeMin = static_cast<int>(j.minRaw) + static_cast<int>(j.margin);
    const int safeMax = static_cast<int>(j.maxRaw) - static_cast<int>(j.margin);
    if (target < safeMin || target > safeMax) return Error::OutsideSafe;
    raw[i] = target;
  }
  return Error::None;
}

}  // namespace lt100
