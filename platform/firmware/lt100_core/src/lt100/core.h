#pragma once

#include <stdint.h>

#include "calibration.h"
#include "protocol.h"
#include "types.h"

namespace lt100 {

class ServoBus {
 public:
  virtual ~ServoBus() {}
  virtual bool feedback(uint8_t id, ServoFeedback& out) = 0;
  virtual bool readRaw(uint8_t id, int16_t& raw) = 0;
  virtual bool syncWrite(const uint8_t ids[kJointCount],
                         const int16_t pos[kJointCount],
                         const uint16_t speed[kJointCount],
                         const uint8_t acc[kJointCount]) = 0;
  virtual bool torque(uint8_t id, bool on) = 0;
};

class Clock {
 public:
  virtual ~Clock() {}
  virtual uint32_t millis() = 0;
};

class Storage {
 public:
  virtual ~Storage() {}
  virtual bool load(Calibration& cal) = 0;
  virtual bool save(const Calibration& cal) = 0;
  virtual bool clear() = 0;
};

class Output {
 public:
  virtual ~Output() {}
  virtual void line(const char* text) = 0;
};

class Core {
 public:
  Core(ServoBus& bus, Clock& clock, Storage& storage, Output& output);

  void begin();
  void handleLine(const char* line, size_t len);
  void tick();

  Mode mode() const { return mode_; }
  const Calibration& calibration() const { return cal_; }
  uint8_t onlineMask() const { return onlineMask_; }
  uint8_t calMask() const { return calibrationValidMask(cal_); }
  uint8_t torqueMask() const { return torqueMask_; }
  bool torqueKnown() const { return torqueKnown_; }
  bool stream() const { return stream_; }
  uint32_t lastSeq() const { return lastSeq_; }
  Error lastError() const { return lastError_; }
  const ServoFeedback& feedback(uint8_t index) const { return feedback_[index]; }

 private:
  void dispatch(const Command& cmd);
  void handlePose(const Command& cmd);
  void handleTorque(const Command& cmd);
  void handleCal(const Command& cmd);
  void handleClear();
  void readAll();
  void setFault(Error error, uint8_t joint = 0);
  void outputError(Error error, uint8_t joint = 0, uint32_t seq = 0);
  void outputState();
  void outputHello();
  void outputCalStatus();
  void outputLimits();
  void outputOk(const char* text);
  const char* modeName() const;
  const char* errorName(Error error) const;

  ServoBus& bus_;
  Clock& clock_;
  Storage& storage_;
  Output& output_;

  Calibration cal_;
  ServoFeedback feedback_[kJointCount];
  bool online_[kJointCount] = {false, false, false};
  uint8_t onlineMask_ = 0;
  uint8_t previousOnlineMask_ = 0;
  uint8_t torqueMask_ = 0;
  bool torqueKnown_ = false;

  Mode mode_ = Mode::Boot;
  Error lastError_ = Error::None;
  uint32_t now_ = 0;
  uint32_t lastReadMs_ = 0;
  uint32_t lastStateMs_ = 0;
  uint32_t lastPoseMs_ = 0;
  uint32_t lastSeq_ = 0;
  uint32_t seqFallback_ = 0;
  bool stream_ = false;
  bool linkLost_ = false;
};

}  // namespace lt100
