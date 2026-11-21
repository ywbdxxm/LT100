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
    const JointCalibration& j = cal.joint[i];
    // Check q against the safe q interval first; a q far outside the travel
    // would otherwise wrap around into the range during the raw conversion.
    const float qA = rawToQ(j, safeStartRaw(j));
    const float qB = rawToQ(j, safeEndRaw(j));
    const float qLo = qA < qB ? qA : qB;
    const float qHi = qA < qB ? qB : qA;
    if (pose.q[i] < qLo - 1e-3f || pose.q[i] > qHi + 1e-3f) {
      return Error::OutsideSafe;
    }
    int16_t target = 0;
    if (!qToRaw(j, pose.q[i], target)) return Error::Range;
    if (!rawInSafeRange(j, target)) return Error::OutsideSafe;
    raw[i] = target;
  }
  return Error::None;
}

}  // namespace lt100
