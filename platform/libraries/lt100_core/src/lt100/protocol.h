#pragma once

#include <stdint.h>

#include "types.h"

namespace lt100 {

enum class Verb : uint8_t {
  Unknown = 0,
  Hello,
  State,
  Stream,
  Pose,
  Jog,
  Raw,
  Stop,
  Estop,
  Torque,
  CalStatus,
  CalRef,
  CalDir,
  CalMark,
  CalSplit,
  CalSave,
  CalClear,
  Limits,
  Clear,
  IdGet,
  IdSet,
};

struct Command {
  Verb verb = Verb::Unknown;
  uint32_t seq = 0;
  bool hasSeq = false;
  Pose pose;
  uint16_t speed = kDefaultSpeed;  // deg/s
  uint8_t acc = 0;                 // servo acceleration register, 0..kMaxAcc
  uint8_t joint = 0;  // 0 = all / not applicable
  bool on = false;
  int8_t sign = 1;
  float q = 0.0f;
  int8_t mark = 0;    // -1 = MIN, +1 = MAX
  int8_t split = 0;   // -1 = keep low side, +1 = keep high side
  int16_t raw = 0;    // RAW move target (uncalibrated install only)
  bool hasRaw = false;
  uint8_t newId = 0;  // ID SET target
};

struct ParseResult {
  bool ok = false;
  Error error = Error::None;
  Command command;
};

ParseResult parseLine(const char* line, size_t len);

}  // namespace lt100
