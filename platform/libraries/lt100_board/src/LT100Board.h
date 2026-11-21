#pragma once

#include <Arduino.h>
#include <Preferences.h>
#include <SCServo.h>

#include "LT100Core.h"

namespace lt100board {

class ScsServoBus : public lt100::ServoBus {
 public:
  explicit ScsServoBus(SMS_STS& bus) : bus_(bus) {}

  bool feedback(uint8_t id, lt100::ServoFeedback& out) override {
    if (!validId(id) || bus_.FeedBack(id) < 0) return false;
    out.online = true;
    out.raw = static_cast<int16_t>(bus_.ReadPos(-1));
    out.load = static_cast<int16_t>(bus_.ReadLoad(-1));
    out.current = static_cast<int16_t>(bus_.ReadCurrent(-1));
    out.voltage = static_cast<int16_t>(bus_.ReadVoltage(-1));
    out.temp = static_cast<int8_t>(bus_.ReadTemper(-1));
    return true;
  }

  bool readRaw(uint8_t id, int16_t& raw) override {
    if (!validId(id)) return false;
    const int pos = bus_.ReadPos(id);
    if (pos < lt100::kRawMin || pos > lt100::kRawMax) return false;
    raw = static_cast<int16_t>(pos);
    return true;
  }

  bool syncWrite(const uint8_t ids[lt100::kJointCount],
                 const int16_t pos[lt100::kJointCount],
                 const uint16_t speed[lt100::kJointCount],
                 const uint8_t acc[lt100::kJointCount]) override {
    uint8_t idCopy[lt100::kJointCount];
    int16_t posCopy[lt100::kJointCount];
    uint16_t speedCopy[lt100::kJointCount];
    uint8_t accCopy[lt100::kJointCount];
    for (uint8_t i = 0; i < lt100::kJointCount; i++) {
      idCopy[i] = ids[i];
      posCopy[i] = pos[i];
      speedCopy[i] = speed[i];
      accCopy[i] = acc[i];
    }
    // SyncWrite has no per-frame ACK; online state is checked before POSE.
    bus_.SyncWritePosEx(idCopy, lt100::kJointCount, posCopy, speedCopy, accCopy);
    return true;
  }

  bool writePos(uint8_t id, int16_t pos, uint16_t speed, uint8_t acc) override {
    return validId(id) && bus_.WritePosEx(id, pos, speed, acc) != 0;
  }

  bool readId(uint8_t id, uint8_t& out) override {
    if (!validId(id)) return false;
    const int value = bus_.readByte(id, SMS_STS_ID);
    if (value < 1 || value > 253) return false;
    out = static_cast<uint8_t>(value);
    return true;
  }

  bool writeId(uint8_t oldId, uint8_t newId) override {
    if (!validId(oldId) || newId < 1 || newId > lt100::kJointCount) return false;
    if (bus_.unLockEprom(oldId) != 1) return false;
    const int written = bus_.writeByte(oldId, SMS_STS_ID, newId);
    bus_.LockEprom(newId);
    return written == 1;
  }

  bool torque(uint8_t id, bool on) override {
    return validId(id) && bus_.EnableTorque(id, on ? 1 : 0) != 0;
  }

 private:
  static bool validId(uint8_t id) {
    return id >= 1 && id <= lt100::kJointCount;
  }

  SMS_STS& bus_;
};

class PreferencesStorage : public lt100::Storage {
 public:
  bool load(lt100::Calibration& cal) override {
    preferences_.begin("lt100cal", true);
    const size_t stored = preferences_.getBytesLength("cal");
    const bool ok =
        stored == sizeof(cal) &&
        preferences_.getBytes("cal", &cal, sizeof(cal)) == sizeof(cal);
    preferences_.end();
    return ok;
  }

  bool save(const lt100::Calibration& cal) override {
    preferences_.begin("lt100cal", false);
    const size_t written = preferences_.putBytes("cal", &cal, sizeof(cal));
    preferences_.end();
    return written == sizeof(cal);
  }

  bool clear() override {
    preferences_.begin("lt100cal", false);
    const bool ok = preferences_.clear();
    preferences_.end();
    return ok;
  }

 private:
  Preferences preferences_;
};

class ArduinoClock : public lt100::Clock {
 public:
  uint32_t millis() override { return static_cast<uint32_t>(::millis()); }
};

class SerialOutput : public lt100::Output {
 public:
  explicit SerialOutput(Stream& serial) : serial_(serial) {}
  void line(const char* text) override { serial_.println(text); }

 private:
  Stream& serial_;
};

class LineReader {
 public:
  LineReader(lt100::Core& core, Stream& serial) : core_(core), serial_(serial) {}

  void poll() {
    while (serial_.available() > 0) {
      const int value = serial_.read();
      if (value < 0) return;
      const char c = static_cast<char>(value);
      if (c == '\r') continue;
      if (c == '\n') {
        if (overflow_) {
          core_.handleLine(buffer_, lt100::kMaxLine + 1);
        } else if (length_ > 0) {
          buffer_[length_] = 0;
          core_.handleLine(buffer_, length_);
        }
        length_ = 0;
        overflow_ = false;
        continue;
      }
      if (length_ < lt100::kMaxLine) {
        buffer_[length_++] = c;
      } else {
        overflow_ = true;
      }
    }
  }

 private:
  lt100::Core& core_;
  Stream& serial_;
  char buffer_[lt100::kMaxLine + 1];
  size_t length_ = 0;
  bool overflow_ = false;
};

}  // namespace lt100board
