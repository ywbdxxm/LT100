#pragma once

#include <stdint.h>

#include "types.h"

namespace lt100 {

struct JointCalibration {
  int16_t zeroRaw = 0;
  float zeroQ = 0.0f;   // model angle (degrees) at the reference pose
  int8_t sign = 1;      // +1 / -1: raw increasing direction vs q
  int16_t minRaw = 0;
  int16_t maxRaw = 0;
  uint16_t margin = kDefaultMargin;
  bool hasRef = false;
  bool hasMin = false;
  bool hasMax = false;
};

struct Calibration {
  uint8_t version = 1;
  JointCalibration joint[kJointCount];
  uint16_t checksum = 0;
};

bool calibrationValidate(const Calibration& cal);
bool calibrationComplete(const Calibration& cal);
bool calibrationJointValid(const JointCalibration& joint);
uint8_t calibrationValidMask(const Calibration& cal);

uint16_t calibrationChecksum(const Calibration& cal);
void calibrationSetChecksum(Calibration& cal);

float rawToQ(const JointCalibration& joint, int16_t raw);
bool qToRaw(const JointCalibration& joint, float q, int16_t& raw);

}  // namespace lt100
