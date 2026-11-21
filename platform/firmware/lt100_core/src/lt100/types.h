#pragma once

#include <stdint.h>
#include <stddef.h>

namespace lt100 {

constexpr uint8_t kJointCount = 3;
constexpr uint8_t kProtocolVersion = 1;
constexpr const char* kFirmwareVersion = "0.1.0";
constexpr int kRawMin = 0;
constexpr int kRawMax = 4095;
constexpr float kTicksPerDegree = 4096.0f / 360.0f;
constexpr uint16_t kDefaultMargin = 40;
constexpr uint16_t kDefaultSpeed = 22;  // deg/s, about 250 servo ticks/s
constexpr uint16_t kMaxSpeed = 52;      // deg/s, about 600 servo ticks/s
constexpr uint8_t kMaxAcc = 254;        // servo acceleration register
constexpr uint32_t kStatePeriodMs = 100;
constexpr uint32_t kLinkTimeoutMs = 300;
constexpr size_t kMaxLine = 128;

enum class Mode : uint8_t {
  Boot = 0,
  Uncal,
  Calibrating,
  Ready,
  Motion,
  Fault,
  Estop,
};

enum class Error : uint8_t {
  None = 0,
  UnknownCommand = 1,
  BadArgs = 2,
  Range = 3,
  LineTooLong = 5,
  ServoOffline = 6,
  NoAck = 7,
  Endpoints = 8,
  Uncalibrated = 9,
  OutsideSafe = 10,
  BadMode = 11,
  Busy = 12,
  Protocol = 13,
  Storage = 14,
  OverTemp = 15,
  UnderVolt = 16,
  LinkLost = 17,
  Internal = 18,
};

struct ServoFeedback {
  bool online = false;
  int16_t raw = 0;
  int16_t load = 0;      // SCServo ReadLoad: output voltage percentage 0..1000
  int16_t current = 0;   // SCServo ReadCurrent: raw current units, not calibrated amps
  int16_t voltage = 0;   // 0.1 V
  int8_t temp = 0;       // degrees C
};

struct Pose {
  float q[kJointCount] = {0.0f, 0.0f, 0.0f};
};

}  // namespace lt100
