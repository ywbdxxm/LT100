#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "lt100/core.h"
#include "lt100/limits.h"
#include "lt100/protocol.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      g_failures++;                                                        \
    }                                                                      \
  } while (0)

#define CHECK_NEAR(a, b, eps)                                                \
  do {                                                                       \
    const double va = static_cast<double>(a);                                \
    const double vb = static_cast<double>(b);                                \
    if (std::fabs(va - vb) > (eps)) {                                        \
      std::fprintf(stderr, "FAIL %s:%d: %s=%.4f != %s=%.4f\n", __FILE__,     \
                   __LINE__, #a, va, #b, vb);                                \
      g_failures++;                                                          \
    }                                                                        \
  } while (0)

struct FakeBus : public lt100::ServoBus {
  bool online[lt100::kJointCount] = {true, true, true};
  int16_t raw[lt100::kJointCount] = {2048, 2048, 2048};
  bool syncOk = true;
  int syncCount = 0;
  int16_t lastPos[lt100::kJointCount] = {0, 0, 0};
  uint16_t lastSpeed[lt100::kJointCount] = {0, 0, 0};
  uint8_t lastAcc[lt100::kJointCount] = {0, 0, 0};
  bool lastTorque[lt100::kJointCount] = {false, false, false};

  bool feedback(uint8_t id, lt100::ServoFeedback& out) override {
    if (id < 1 || id > lt100::kJointCount || !online[id - 1]) return false;
    out.online = true;
    out.raw = raw[id - 1];
    out.load = 100;
    out.current = 20;
    out.voltage = 120;
    out.temp = 27;
    return true;
  }

  bool readRaw(uint8_t id, int16_t& value) override {
    if (id < 1 || id > lt100::kJointCount || !online[id - 1]) return false;
    value = raw[id - 1];
    return true;
  }

  bool syncWrite(const uint8_t ids[lt100::kJointCount],
                 const int16_t pos[lt100::kJointCount],
                 const uint16_t speed[lt100::kJointCount],
                 const uint8_t acc[lt100::kJointCount]) override {
    if (!syncOk) return false;
    syncCount++;
    for (uint8_t i = 0; i < lt100::kJointCount; i++) {
      CHECK(ids[i] == i + 1);
      lastPos[i] = pos[i];
      lastSpeed[i] = speed[i];
      lastAcc[i] = acc[i];
    }
    return true;
  }

  bool torque(uint8_t id, bool on) override {
    if (id < 1 || id > lt100::kJointCount || !online[id - 1]) return false;
    lastTorque[id - 1] = on;
    return true;
  }
};

struct FakeClock : public lt100::Clock {
  uint32_t now = 0;
  uint32_t millis() override { return now; }
};

struct FakeStorage : public lt100::Storage {
  bool has = false;
  bool failLoad = false;
  bool failSave = false;
  lt100::Calibration saved;

  bool load(lt100::Calibration& cal) override {
    if (failLoad || !has) return false;
    cal = saved;
    return true;
  }

  bool save(const lt100::Calibration& cal) override {
    if (failSave) return false;
    saved = cal;
    has = true;
    return true;
  }

  bool clear() override {
    has = false;
    return true;
  }
};

struct FakeOutput : public lt100::Output {
  std::string text;
  void line(const char* s) override {
    text += s;
    text += '\n';
  }
  bool contains(const char* s) const { return text.find(s) != std::string::npos; }
  void reset() { text.clear(); }
};

lt100::Calibration makeCalibration() {
  lt100::Calibration cal;
  for (uint8_t i = 0; i < lt100::kJointCount; i++) {
    lt100::JointCalibration& j = cal.joint[i];
    j.zeroRaw = 2048;
    j.zeroQ = 0.0f;
    j.sign = 1;
    j.minRaw = 1000;
    j.maxRaw = 3000;
    j.margin = 40;
    j.hasRef = true;
    j.hasMin = true;
    j.hasMax = true;
  }
  lt100::calibrationSetChecksum(cal);
  return cal;
}

void send(lt100::Core& core, const char* line) {
  core.handleLine(line, std::strlen(line));
}

void testCalibrationMath() {
  lt100::Calibration cal = makeCalibration();
  CHECK(lt100::calibrationValidate(cal));
  CHECK(lt100::calibrationComplete(cal));
  CHECK(lt100::calibrationValidMask(cal) == 0x07);

  lt100::JointCalibration& j = cal.joint[0];
  CHECK_NEAR(lt100::rawToQ(j, 2048), 0.0, 1e-4);
  CHECK_NEAR(lt100::rawToQ(j, 2560), 45.0, 1e-3);

  int16_t raw = -1;
  CHECK(lt100::qToRaw(j, 45.0f, raw));
  CHECK(raw == 2560);
  CHECK(lt100::qToRaw(j, 0.0f, raw) && raw == 2048);
  CHECK(!lt100::qToRaw(j, 1000.0f, raw));

  j.zeroQ = -90.0f;
  CHECK(lt100::qToRaw(j, -90.0f, raw) && raw == 2048);
  CHECK(lt100::qToRaw(j, 0.0f, raw) && raw == 3072);

  j.zeroQ = 0.0f;
  j.sign = -1;
  CHECK(lt100::qToRaw(j, 30.0f, raw));
  CHECK(raw == 1707);

  lt100::Calibration bad = cal;
  bad.version = 2;
  CHECK(!lt100::calibrationValidate(bad));

  lt100::Calibration changed = cal;
  changed.joint[0].zeroQ = 1.0f;
  CHECK(lt100::calibrationChecksum(changed) !=
        lt100::calibrationChecksum(cal));

  lt100::Calibration outside = cal;
  outside.joint[0].zeroRaw = 1020;  // inside raw min, outside safe min
  CHECK(!lt100::calibrationJointValid(outside.joint[0]));
  CHECK(!lt100::calibrationValidate(outside));
}

void testLimits() {
  lt100::Calibration cal = makeCalibration();
  int16_t raw[lt100::kJointCount] = {0, 0, 0};
  lt100::Pose pose;
  pose.q[0] = pose.q[1] = pose.q[2] = 0.0f;
  CHECK(lt100::checkPose(cal, pose, 30, 20, raw) == lt100::Error::None);
  CHECK(raw[0] == 2048);

  pose.q[0] = 100.0f;  // 3185 raw, outside 1040..2960
  CHECK(lt100::checkPose(cal, pose, 30, 20, raw) ==
        lt100::Error::OutsideSafe);

  pose.q[0] = 0.0f;
  CHECK(lt100::checkPose(cal, pose, 0, 20, raw) == lt100::Error::Range);
  CHECK(lt100::checkPose(cal, pose, 53, 20, raw) == lt100::Error::Range);
  CHECK(lt100::checkPose(cal, pose, 30, 255, raw) == lt100::Error::Range);

  lt100::Calibration incomplete;
  CHECK(lt100::checkPose(incomplete, pose, 30, 20, raw) ==
        lt100::Error::Uncalibrated);
}

void testProtocol() {
  const char* line = "POSE seq=7 q=1.5,-2,3 speed=100 acc=10";
  lt100::ParseResult r = lt100::parseLine(line, std::strlen(line));
  CHECK(r.ok);
  CHECK(r.command.verb == lt100::Verb::Pose);
  CHECK(r.command.seq == 7 && r.command.hasSeq);
  CHECK_NEAR(r.command.pose.q[0], 1.5, 1e-6);
  CHECK_NEAR(r.command.pose.q[1], -2.0, 1e-6);
  CHECK(r.command.speed == 100);
  CHECK(r.command.acc == 10);

  const char* badQ = "POSE q=1,2";
  r = lt100::parseLine(badQ, std::strlen(badQ));
  CHECK(!r.ok && r.error == lt100::Error::BadArgs);

  const char* badKey = "POSE q=1,2,3 foo=4";
  r = lt100::parseLine(badKey, std::strlen(badKey));
  CHECK(!r.ok && r.error == lt100::Error::BadArgs);

  const char* calRef = "cal ref 2 -90.5";
  r = lt100::parseLine(calRef, std::strlen(calRef));
  CHECK(r.ok && r.command.verb == lt100::Verb::CalRef && r.command.joint == 2);
  CHECK_NEAR(r.command.q, -90.5, 1e-6);

  const char* torque = "TORQUE all OFF";
  r = lt100::parseLine(torque, std::strlen(torque));
  CHECK(r.ok && r.command.verb == lt100::Verb::Torque && r.command.joint == 0 &&
        !r.command.on);

  const char* stream = "STREAM ON";
  r = lt100::parseLine(stream, std::strlen(stream));
  CHECK(r.ok && r.command.verb == lt100::Verb::Stream && r.command.on);

  const char* bogusCal = "CAL FOO 1";
  r = lt100::parseLine(bogusCal, std::strlen(bogusCal));
  CHECK(!r.ok && r.error == lt100::Error::UnknownCommand);

  const char* unknown = "WIGGLE";
  r = lt100::parseLine(unknown, std::strlen(unknown));
  CHECK(!r.ok && r.error == lt100::Error::UnknownCommand);

  const char* extra = "STOP now";
  r = lt100::parseLine(extra, std::strlen(extra));
  CHECK(!r.ok && r.error == lt100::Error::BadArgs);

  std::string tooLong(lt100::kMaxLine + 1, 'A');
  r = lt100::parseLine(tooLong.c_str(), tooLong.size());
  CHECK(!r.ok && r.error == lt100::Error::LineTooLong);
}

struct Fixture {
  FakeBus bus;
  FakeClock clock;
  FakeStorage storage;
  FakeOutput output;
  lt100::Core core;

  Fixture() : core(bus, clock, storage, output) {}

  void calibrateAll() {
    clock.now = 1000;
    core.begin();
    send(core, "TORQUE all OFF");
    for (uint8_t id = 1; id <= lt100::kJointCount; id++) {
      bus.raw[id - 1] = 2048;
      char ref[32];
      std::snprintf(ref, sizeof(ref), "CAL REF %u 0", id);
      send(core, ref);
      bus.raw[id - 1] = 1000;
      char minLine[32];
      std::snprintf(minLine, sizeof(minLine), "CAL MARK %u MIN", id);
      send(core, minLine);
      bus.raw[id - 1] = 3000;
      char maxLine[32];
      std::snprintf(maxLine, sizeof(maxLine), "CAL MARK %u MAX", id);
      send(core, maxLine);
    }
    send(core, "CAL SAVE");
    send(core, "TORQUE all ON");
  }
};

void testCoreUncalibrated() {
  Fixture f;
  f.core.begin();
  CHECK(f.core.mode() == lt100::Mode::Uncal);
  CHECK(f.core.calMask() == 0);
  send(f.core, "POSE q=0,0,0");
  CHECK(f.output.contains("code=9"));
  CHECK(f.bus.syncCount == 0);
  send(f.core, "STOP");
  CHECK(f.core.mode() == lt100::Mode::Uncal);
}

void testCoreCalibrationAndMotion() {
  Fixture f;
  f.calibrateAll();
  CHECK(f.storage.has);
  CHECK(f.core.mode() == lt100::Mode::Ready);
  CHECK(f.core.calMask() == 0x07);
  CHECK(f.core.torqueMask() == 0x07);

  send(f.core, "POSE seq=42 q=45,45,45 speed=30 acc=20");
  CHECK(f.core.mode() == lt100::Mode::Motion);
  CHECK(f.core.lastSeq() == 42);
  CHECK(f.bus.syncCount == 1);
  CHECK(f.bus.lastPos[0] == 2560);
  CHECK(f.bus.lastSpeed[0] == 341);
  CHECK(f.bus.lastAcc[0] == 20);

  send(f.core, "CAL SAVE");
  CHECK(f.output.contains("code=11"));
  send(f.core, "CAL CLEAR all");
  CHECK(f.output.contains("code=11"));

  for (uint8_t i = 0; i < lt100::kJointCount; i++) {
    f.bus.raw[i] = 2560;  // fake: the servos reached the target
  }
  f.clock.now += lt100::kStatePeriodMs;
  f.core.tick();
  send(f.core, "STATE");
  CHECK(f.output.contains("mode=MOTION"));
  CHECK(f.output.contains("online=7"));
  CHECK(f.output.contains("cal=7"));
  CHECK(f.output.contains("torque=7"));
  CHECK(f.output.contains("q=45.0,45.0,45.0"));

  send(f.core, "POSE q=100,0,0");
  CHECK(f.output.contains("code=10"));
  CHECK(f.bus.syncCount == 1);

  f.clock.now += lt100::kLinkTimeoutMs + 1;
  f.core.tick();
  CHECK(f.core.mode() == lt100::Mode::Ready);
  CHECK(f.output.contains("code=17"));

  send(f.core, "STOP");
  CHECK(f.core.mode() == lt100::Mode::Ready);
  send(f.core, "ESTOP");
  CHECK(f.core.mode() == lt100::Mode::Estop);
  send(f.core, "POSE q=0,0,0");
  CHECK(f.output.contains("code=11"));
  send(f.core, "CLEAR");
  CHECK(f.core.mode() == lt100::Mode::Ready);
}

void testCoreFaultOnOffline() {
  Fixture f;
  f.calibrateAll();
  f.bus.online[1] = false;
  f.clock.now += lt100::kStatePeriodMs;
  f.core.tick();
  CHECK(f.core.mode() == lt100::Mode::Fault);
  CHECK(f.core.lastError() == lt100::Error::ServoOffline);
  CHECK(f.output.contains("code=6"));
  send(f.core, "POSE q=0,0,0");
  CHECK(f.output.contains("code=11"));
  send(f.core, "CLEAR");
  CHECK(f.core.mode() == lt100::Mode::Fault);
  CHECK(f.output.contains("code=6"));

  f.bus.online[1] = true;
  f.clock.now += lt100::kStatePeriodMs;
  f.core.tick();
  send(f.core, "CLEAR");
  CHECK(f.core.mode() == lt100::Mode::Ready);
}

void testCoreCalibrationRules() {
  Fixture f;
  f.clock.now = 1000;
  f.core.begin();
  send(f.core, "CAL REF 1 0");
  CHECK(f.output.contains("code=11"));  // torque state unknown

  send(f.core, "TORQUE all OFF");
  f.bus.raw[0] = 2048;
  send(f.core, "CAL REF 1 0");
  CHECK(f.output.contains("OK cal_ref"));
  CHECK(f.core.mode() == lt100::Mode::Calibrating);
  send(f.core, "POSE q=0,0,0");
  CHECK(f.output.contains("code=11"));
  send(f.core, "TORQUE all ON");
  CHECK(f.output.contains("code=11"));
  send(f.core, "STOP");
  CHECK(f.core.mode() == lt100::Mode::Calibrating);
  f.bus.raw[0] = 1000;
  send(f.core, "CAL MARK 1 MIN");
  f.bus.raw[0] = 3000;
  send(f.core, "CAL MARK 1 MAX");
  send(f.core, "CAL STATUS");
  CHECK(f.output.contains("CAL id=1 ref=1 min_set=1 max_set=1"));
  CHECK(f.output.contains("valid=1"));

  send(f.core, "CAL DIR 1 -1");
  CHECK(f.core.calibration().joint[0].sign == -1);
  send(f.core, "TORQUE all ON");
  CHECK(f.output.contains("code=11"));  // CAL mode blocks torque

  f.core.handleLine("CAL SAVE", 8);
  CHECK(f.output.contains("OK cal_saved"));
  CHECK(f.storage.has);

  send(f.core, "CAL CLEAR all");
  CHECK(f.core.calMask() == 0);
  CHECK(!f.storage.has);
}

void testCoreStorageChecksum() {
  FakeBus bus;
  FakeClock clock;
  FakeStorage storage;
  FakeOutput output;
  storage.has = true;
  storage.saved = makeCalibration();
  storage.saved.joint[0].zeroRaw += 1;
  lt100::Core core(bus, clock, storage, output);
  core.begin();
  CHECK(core.mode() == lt100::Mode::Uncal);
  CHECK(core.lastError() == lt100::Error::Storage);
}

void testCoreStorageFailure() {
  Fixture f;
  f.storage.failSave = true;
  f.clock.now = 1000;
  f.core.begin();
  send(f.core, "TORQUE all OFF");
  for (uint8_t id = 1; id <= lt100::kJointCount; id++) {
    f.bus.raw[id - 1] = 2048;
    char line[32];
    std::snprintf(line, sizeof(line), "CAL REF %u 0", id);
    send(f.core, line);
    f.bus.raw[id - 1] = 1000;
    std::snprintf(line, sizeof(line), "CAL MARK %u MIN", id);
    send(f.core, line);
    f.bus.raw[id - 1] = 3000;
    std::snprintf(line, sizeof(line), "CAL MARK %u MAX", id);
    send(f.core, line);
  }
  send(f.core, "CAL SAVE");
  CHECK(f.output.contains("code=14"));
  CHECK(f.core.mode() == lt100::Mode::Calibrating);
  send(f.core, "POSE q=0,0,0");
  CHECK(f.output.contains("code=11"));

  f.storage.failSave = false;
  send(f.core, "CAL SAVE");
  CHECK(f.output.contains("OK cal_saved"));
  CHECK(f.core.mode() == lt100::Mode::Ready);
}

void testCoreSyncFailure() {
  Fixture f;
  f.calibrateAll();
  f.bus.syncOk = false;
  send(f.core, "POSE q=0,0,0");
  CHECK(f.core.mode() == lt100::Mode::Fault);
  CHECK(f.core.lastError() == lt100::Error::NoAck);
  CHECK(f.output.contains("code=7"));
}

void testCoreStreamAndState() {
  Fixture f;
  f.calibrateAll();
  send(f.core, "STREAM ON");
  f.output.reset();
  f.clock.now += lt100::kStatePeriodMs;
  f.core.tick();
  CHECK(f.output.contains("STATE "));
  CHECK(f.output.contains("age=0"));
  send(f.core, "STREAM OFF");
  f.output.reset();
  f.clock.now += lt100::kStatePeriodMs;
  f.core.tick();
  CHECK(!f.output.contains("STATE "));
}

}  // namespace

int main() {
  testCalibrationMath();
  testLimits();
  testProtocol();
  testCoreUncalibrated();
  testCoreCalibrationAndMotion();
  testCoreFaultOnOffline();
  testCoreCalibrationRules();
  testCoreStorageChecksum();
  testCoreStorageFailure();
  testCoreSyncFailure();
  testCoreStreamAndState();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all checks passed\n");
  return 0;
}
