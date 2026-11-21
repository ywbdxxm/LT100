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

// Raw values are single-turn (0..4095). A marked travel may be stored with
// minRaw > maxRaw while the operator chooses a side; the default angle mode
// cannot execute it, so CAL SPLIT clamps one end to the seam before save.
int calibrationSpanTicks(const JointCalibration& joint);
int16_t safeStartRaw(const JointCalibration& joint);
int16_t safeEndRaw(const JointCalibration& joint);
bool rawInJointRange(const JointCalibration& joint, int raw);
bool rawInSafeRange(const JointCalibration& joint, int raw);

// Normalize the endpoints so the travel (minRaw -> maxRaw along increasing
// raw) contains the reference pose. The two ends leave two candidate arcs;
// the reference pose is the only physical evidence of which one is reachable,
// so it selects the arc. The caller must place the reference inside the
// intended travel -- geometry alone cannot verify that.
void calibrationOrientEndpoints(JointCalibration& joint);

bool calibrationValidate(const Calibration& cal);
bool calibrationComplete(const Calibration& cal);
bool calibrationJointValid(const JointCalibration& joint);
// Geometry-valid AND executable by the default ST3215 angle mode. That mode
// treats goal positions as 0..4095 and moves by the signed difference, so it
// cannot follow a calibrated arc across 0 (minRaw > maxRaw). Such a calibration
// stays loadable so the operator can inspect/replace it, but it is not usable
// for motion, the ready mask, or CAL SAVE.
bool calibrationJointUsable(const JointCalibration& joint);
uint8_t calibrationValidMask(const Calibration& cal);

uint16_t calibrationChecksum(const Calibration& cal);
void calibrationSetChecksum(Calibration& cal);

float rawToQ(const JointCalibration& joint, int16_t raw);
bool qToRaw(const JointCalibration& joint, float q, int16_t& raw);

}  // namespace lt100
