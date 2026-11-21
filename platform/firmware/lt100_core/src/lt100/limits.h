#pragma once

#include <stdint.h>

#include "calibration.h"
#include "types.h"

namespace lt100 {

// speed is deg/s (1..kMaxSpeed); acc is the servo acceleration register (0..kMaxAcc).
Error checkMotionParams(uint16_t speed, uint8_t acc);
Error checkPose(const Calibration& cal, const Pose& pose, uint16_t speed, uint8_t acc,
                int16_t raw[kJointCount]);

}  // namespace lt100
