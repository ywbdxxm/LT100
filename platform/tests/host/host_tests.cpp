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
  int writeCount = 0;
  int idWrites = 0;
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

  bool writePos(uint8_t id, int16_t pos, uint16_t speed, uint8_t acc) override {
    if (!syncOk || id < 1 || id > lt100::kJointCount || !online[id - 1]) {
      return false;
    }
    writeCount++;
    lastPos[id - 1] = pos;
    lastSpeed[id - 1] = speed;
    lastAcc[id - 1] = acc;
    return true;
  }

  bool readId(uint8_t id, uint8_t& out) override {
    if (id < 1 || id > lt100::kJointCount || !online[id - 1]) return false;
    out = id;
    return true;
  }

  bool writeId(uint8_t oldId, uint8_t newId) override {
    if (!syncOk || oldId < 1 || oldId > lt100::kJointCount ||
        newId < 1 || newId > lt100::kJointCount || !online[oldId - 1]) {
      return false;
    }
    online[oldId - 1] = false;
    online[newId - 1] = true;
    idWrites++;
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
  CHECK(lt100::qToRaw(j, 1000.0f, raw));  // pure conversion; range checks live in checkPose

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

void testWrapRange() {
  lt100::JointCalibration wrap;
  wrap.hasRef = wrap.hasMin = wrap.hasMax = true;
  wrap.zeroRaw = 100;
  wrap.zeroQ = 0;
  wrap.sign = 1;
  wrap.minRaw = 4000;
  wrap.maxRaw = 200;
  wrap.margin = 40;
  CHECK(lt100::calibrationJointValid(wrap));
  CHECK(!lt100::calibrationJointUsable(wrap));  // default angle mode cannot cross 0
  CHECK(lt100::calibrationSpanTicks(wrap) == 296);
  CHECK(lt100::rawInSafeRange(wrap, 4050));
  CHECK(lt100::rawInSafeRange(wrap, 100));
  CHECK(!lt100::rawInSafeRange(wrap, 500));
  int16_t raw = 0;
  CHECK(lt100::qToRaw(wrap, -7.0f, raw) && raw == 20);
  const float q = lt100::rawToQ(wrap, 4090);
  CHECK(q < 0.0f && q > -10.0f);
  const float wrapHi = lt100::rawToQ(wrap, lt100::safeEndRaw(wrap));
  CHECK(190.0f > wrapHi);  // outside the safe q interval

  // A calibrated arc longer than 180 degrees stays unambiguous.
  lt100::JointCalibration wide = wrap;
  wide.zeroRaw = 600;
  wide.minRaw = 500;
  wide.maxRaw = 3000;
  CHECK(lt100::calibrationJointValid(wide));
  const float wideQ = lt100::rawToQ(wide, 2700);
  CHECK(wideQ > 180.0f && wideQ < 190.0f);
  CHECK(lt100::qToRaw(wide, wideQ, raw) && raw == 2700);
  const float wideLo = lt100::rawToQ(wide, lt100::safeStartRaw(wide));
  CHECK(-10.0f < wideLo);  // outside the safe q interval

  lt100::Calibration cal;
  for (uint8_t i = 0; i < lt100::kJointCount; i++) cal.joint[i] = wrap;
  lt100::Pose pose;
  pose.q[0] = pose.q[1] = pose.q[2] = -7.0f;
  int16_t targets[lt100::kJointCount] = {0, 0, 0};
  // The circular math still computes, but a cross-0 travel is not executable
  // by the default ST3215 angle mode, so POSE refuses it as uncalibrated.
  CHECK(lt100::checkPose(cal, pose, 30, 20, targets) == lt100::Error::Uncalibrated);
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

  const char* jog = "JOG seq=9 id=2 q=-12.5 speed=30 acc=20";
  r = lt100::parseLine(jog, std::strlen(jog));
  CHECK(r.ok && r.command.verb == lt100::Verb::Jog && r.command.joint == 2);
  CHECK(r.command.seq == 9 && r.command.hasSeq);
  CHECK_NEAR(r.command.q, -12.5, 1e-6);
  CHECK(r.command.speed == 30 && r.command.acc == 20);

  const char* jogNoId = "JOG q=0";
  r = lt100::parseLine(jogNoId, std::strlen(jogNoId));
  CHECK(!r.ok && r.error == lt100::Error::BadArgs);

  const char* idGet = "ID GET";
  r = lt100::parseLine(idGet, std::strlen(idGet));
  CHECK(r.ok && r.command.verb == lt100::Verb::IdGet);

  const char* idSet = "id set 3";
  r = lt100::parseLine(idSet, std::strlen(idSet));
  CHECK(r.ok && r.command.verb == lt100::Verb::IdSet && r.command.newId == 3);

  const char* idBad = "ID SET 9";
  r = lt100::parseLine(idBad, std::strlen(idBad));
  CHECK(!r.ok && r.error == lt100::Error::BadArgs);

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

  // STOP while moving halts at the present pose.
  f.bus.raw[0] = 1500;
  f.bus.raw[1] = 1600;
  f.bus.raw[2] = 1700;
  f.bus.writeCount = 0;
  send(f.core, "STOP");
  CHECK(f.core.mode() == lt100::Mode::Ready);
  CHECK(f.bus.writeCount == 3);
  CHECK(f.bus.lastPos[0] == 1500 && f.bus.lastPos[1] == 1600 &&
        f.bus.lastPos[2] == 1700);

  // Resume motion for the link-lost dead-man check below.
  send(f.core, "POSE q=45,0,0");
  CHECK(f.core.mode() == lt100::Mode::Motion);

  send(f.core, "POSE q=100,0,0");
  CHECK(f.output.contains("code=10"));
  CHECK(f.bus.syncCount == 2);

  f.clock.now += lt100::kLinkTimeoutMs + 1;
  f.core.tick();
  CHECK(f.core.mode() == lt100::Mode::Ready);
  CHECK(f.output.contains("code=17"));

  send(f.core, "STOP");
  CHECK(f.core.mode() == lt100::Mode::Ready);
  f.bus.raw[0] = 2000;
  f.bus.raw[1] = 2100;
  f.bus.raw[2] = 2200;
  f.bus.writeCount = 0;
  send(f.core, "ESTOP");
  CHECK(f.core.mode() == lt100::Mode::Estop);
  CHECK(f.bus.writeCount == 3);  // present pose written back = halt now
  CHECK(f.bus.lastPos[0] == 2000 && f.bus.lastPos[1] == 2100 &&
        f.bus.lastPos[2] == 2200);
  send(f.core, "POSE q=0,0,0");
  CHECK(f.output.contains("code=11"));
  send(f.core, "CLEAR");
  CHECK(f.core.mode() == lt100::Mode::Ready);
}

void testCoreJogSingleJoint() {
  Fixture f;
  f.clock.now = 1000;
  f.core.begin();
  send(f.core, "TORQUE all OFF");
  f.bus.raw[0] = 2048;
  send(f.core, "CAL REF 1 0");
  f.bus.raw[0] = 1000;
  send(f.core, "CAL MARK 1 MIN");
  f.bus.raw[0] = 3000;
  send(f.core, "CAL MARK 1 MAX");
  send(f.core, "CAL SAVE");
  CHECK(f.core.calMask() == 0x01);
  CHECK(f.core.mode() == lt100::Mode::Uncal);

  send(f.core, "TORQUE 1 ON");
  CHECK(f.core.torqueMask() == 0x01);

  f.output.reset();
  f.bus.writeCount = 0;
  send(f.core, "JOG seq=3 id=1 q=10 speed=30 acc=20");
  CHECK(f.output.contains("OK jog"));
  CHECK(f.core.mode() == lt100::Mode::Motion);
  CHECK(f.core.lastSeq() == 3);
  CHECK(f.bus.writeCount == 1);
  CHECK(f.bus.lastPos[0] == 2162);
  CHECK(f.bus.lastSpeed[0] == 341);
  CHECK(f.bus.lastAcc[0] == 20);

  // A one-shot JOG must not raise the POSE dead-man link_lost error.
  f.output.reset();
  f.clock.now += lt100::kLinkTimeoutMs + 1;
  f.core.tick();
  CHECK(f.core.mode() == lt100::Mode::Ready);
  CHECK(!f.output.contains("code=17"));

  // A move must not start while the joint is outside its calibrated travel.
  f.bus.raw[0] = 3500;
  f.output.reset();
  send(f.core, "JOG id=1 q=0 speed=30 acc=20");
  CHECK(f.output.contains("code=10"));
  f.bus.raw[0] = 2048;

  f.output.reset();
  send(f.core, "JOG id=2 q=0 speed=30 acc=20");
  CHECK(f.output.contains("code=9"));
  CHECK(f.bus.writeCount == 1);

  send(f.core, "TORQUE 1 OFF");
  f.output.reset();
  send(f.core, "JOG id=1 q=10 speed=30 acc=20");
  CHECK(f.output.contains("code=11"));

  send(f.core, "TORQUE 1 ON");
  f.output.reset();
  send(f.core, "JOG id=1 q=100 speed=30 acc=20");
  CHECK(f.output.contains("code=10"));
}

void testCoreServoId() {
  Fixture f;
  f.bus.online[1] = false;
  f.bus.online[2] = false;  // only the factory-default ID1 servo
  f.core.begin();
  send(f.core, "ID GET");
  CHECK(f.output.contains("ID value=1"));

  f.output.reset();
  send(f.core, "ID SET 2");
  CHECK(f.output.contains("OK id_set=2"));
  CHECK(f.bus.idWrites == 1);
  CHECK(!f.bus.online[0] && f.bus.online[1]);
  CHECK(f.core.onlineMask() == 0x02);

  f.output.reset();
  send(f.core, "ID GET");
  CHECK(f.output.contains("ID value=2"));

  // Two servos on the bus must refuse any ID operation.
  f.bus.online[2] = true;
  f.output.reset();
  send(f.core, "ID GET");
  CHECK(f.output.contains("code=12"));

  // No servo on the bus.
  f.bus.online[0] = false;
  f.bus.online[1] = false;
  f.bus.online[2] = false;
  f.output.reset();
  send(f.core, "ID SET 1");
  CHECK(f.output.contains("code=6"));
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

void testCoreLoadsCrossZeroButUnusable() {
  FakeBus bus;
  FakeClock clock;
  FakeStorage storage;
  FakeOutput output;
  storage.has = true;
  storage.saved = makeCalibration();
  storage.saved.joint[0].minRaw = 4000;
  storage.saved.joint[0].maxRaw = 200;
  storage.saved.joint[0].zeroRaw = 100;
  lt100::calibrationSetChecksum(storage.saved);
  lt100::Core core(bus, clock, storage, output);
  core.begin();
  // The stored record is geometrically valid and remains visible, but the
  // default angle mode cannot execute it, so it is not in the ready mask.
  CHECK(core.mode() == lt100::Mode::Uncal);
  CHECK(core.calMask() == 0x06);
  CHECK(core.lastError() == lt100::Error::None);
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

void testCoreCalibrationMarkOrder() {
  // Two endpoints leave two candidate arcs; the reference pose selects the one
  // that contains it, so the ends can be marked in either order.
  Fixture f;
  f.clock.now = 1000;
  f.core.begin();
  send(f.core, "TORQUE 1 OFF");
  f.bus.raw[0] = 100;  // reference inside the 4000 -> 0 -> 200 travel
  send(f.core, "CAL REF 1 0");
  f.bus.raw[0] = 4000;
  send(f.core, "CAL MARK 1 MIN");
  f.bus.raw[0] = 200;
  f.output.reset();
  send(f.core, "CAL MARK 1 MAX");
  // Cross-0 is markable so the operator can choose a side, but not savable
  // before that choice.
  CHECK(f.output.contains("OK cal_max"));
  CHECK(f.core.calibration().joint[0].minRaw == 4000);
  CHECK(f.core.calibration().joint[0].maxRaw == 200);
  CHECK(f.core.calMask() == 0x00);
  send(f.core, "CAL SAVE");
  CHECK(f.output.contains("code=8"));

  // Z=100 lives on the low side (0..200); keeping the high side must fail.
  f.output.reset();
  send(f.core, "CAL SPLIT 1 HIGH");
  CHECK(f.output.contains("code=8"));
  f.output.reset();
  send(f.core, "CAL SPLIT 1 LOW");
  CHECK(f.output.contains("OK cal_split"));
  CHECK(f.core.calibration().joint[0].minRaw == 0);
  CHECK(f.core.calibration().joint[0].maxRaw == 200);
  f.output.reset();
  send(f.core, "CAL SAVE");
  CHECK(f.output.contains("OK cal_saved"));
  CHECK(f.core.calMask() == 0x01);

  // Reversed order for the same cross-0 geometry behaves the same.
  Fixture g;
  g.clock.now = 1000;
  g.core.begin();
  send(g.core, "TORQUE 1 OFF");
  g.bus.raw[0] = 100;
  send(g.core, "CAL REF 1 0");
  g.bus.raw[0] = 200;
  send(g.core, "CAL MARK 1 MIN");
  g.bus.raw[0] = 4000;
  g.output.reset();
  send(g.core, "CAL MARK 1 MAX");
  CHECK(g.output.contains("OK cal_max"));
  CHECK(g.core.calMask() == 0x00);
  send(g.core, "CAL SPLIT 1 LOW");
  CHECK(g.output.contains("OK cal_split"));
  send(g.core, "CAL SAVE");
  CHECK(g.output.contains("OK cal_saved"));
  CHECK(g.core.calibration().joint[0].minRaw == 0);
  CHECK(g.core.calibration().joint[0].maxRaw == 200);

  // Non-wrap travel, either order.
  Fixture h;
  h.clock.now = 1000;
  h.core.begin();
  send(h.core, "TORQUE 1 OFF");
  h.bus.raw[0] = 2048;
  send(h.core, "CAL REF 1 0");
  h.bus.raw[0] = 1000;
  send(h.core, "CAL MARK 1 MIN");
  h.bus.raw[0] = 3000;
  send(h.core, "CAL MARK 1 MAX");
  CHECK(h.core.calibration().joint[0].minRaw == 1000);
  CHECK(h.core.calibration().joint[0].maxRaw == 3000);

  Fixture k;
  k.clock.now = 1000;
  k.core.begin();
  send(k.core, "TORQUE 1 OFF");
  k.bus.raw[0] = 2048;
  send(k.core, "CAL REF 1 0");
  k.bus.raw[0] = 3000;
  send(k.core, "CAL MARK 1 MIN");
  k.bus.raw[0] = 1000;
  k.output.reset();
  send(k.core, "CAL MARK 1 MAX");
  CHECK(k.output.contains("OK cal_max"));
  CHECK(k.core.calibration().joint[0].minRaw == 1000);
  CHECK(k.core.calibration().joint[0].maxRaw == 3000);

  // The same two ends select different arcs depending on where Z is.
  Fixture shortArc;
  shortArc.clock.now = 1000;
  shortArc.core.begin();
  send(shortArc.core, "TORQUE 1 OFF");
  shortArc.bus.raw[0] = 800;  // inside 200 -> 1500
  send(shortArc.core, "CAL REF 1 0");
  shortArc.bus.raw[0] = 200;
  send(shortArc.core, "CAL MARK 1 MIN");
  shortArc.bus.raw[0] = 1500;
  send(shortArc.core, "CAL MARK 1 MAX");
  CHECK(shortArc.core.calibration().joint[0].minRaw == 200);
  CHECK(shortArc.core.calibration().joint[0].maxRaw == 1500);

  Fixture longArc;
  longArc.clock.now = 1000;
  longArc.core.begin();
  send(longArc.core, "TORQUE 1 OFF");
  longArc.bus.raw[0] = 2500;  // inside 1500 -> 0 -> 200
  send(longArc.core, "CAL REF 1 0");
  longArc.bus.raw[0] = 200;
  send(longArc.core, "CAL MARK 1 MIN");
  longArc.bus.raw[0] = 1500;
  longArc.output.reset();
  send(longArc.core, "CAL MARK 1 MAX");
  CHECK(longArc.output.contains("OK cal_max"));
  CHECK(longArc.core.calMask() == 0x00);
  send(longArc.core, "CAL SAVE");
  CHECK(longArc.output.contains("code=8"));
  // Z=2500 lives on the high side (1500..4095).
  longArc.output.reset();
  send(longArc.core, "CAL SPLIT 1 HIGH");
  CHECK(longArc.output.contains("OK cal_split"));
  CHECK(longArc.core.calibration().joint[0].minRaw == 1500);
  CHECK(longArc.core.calibration().joint[0].maxRaw == 4095);
  send(longArc.core, "CAL SAVE");
  CHECK(longArc.output.contains("OK cal_saved"));
  CHECK(longArc.core.calMask() == 0x01);

  // Z too close to an end is still rejected: the arc exists but is unsafe.
  Fixture edge;
  edge.clock.now = 1000;
  edge.core.begin();
  send(edge.core, "TORQUE 1 OFF");
  edge.bus.raw[0] = 4020;
  send(edge.core, "CAL REF 1 0");
  edge.bus.raw[0] = 4000;
  send(edge.core, "CAL MARK 1 MIN");
  edge.bus.raw[0] = 200;
  edge.output.reset();
  send(edge.core, "CAL MARK 1 MAX");
  CHECK(edge.output.contains("code=8"));
  CHECK(edge.core.calMask() == 0x00);

  // Two marks at the same raw cannot form a travel.
  Fixture same;
  same.clock.now = 1000;
  same.core.begin();
  send(same.core, "TORQUE 1 OFF");
  same.bus.raw[0] = 100;
  send(same.core, "CAL REF 1 0");
  same.bus.raw[0] = 4000;
  send(same.core, "CAL MARK 1 MIN");
  same.output.reset();
  send(same.core, "CAL MARK 1 MAX");
  CHECK(same.output.contains("code=8"));
  CHECK(same.core.calMask() == 0x00);
}

void testRawMoveInstallation() {
  // Exactly one uncalibrated servo, torque already on: RAW moves it directly.
  Fixture f;
  f.bus.online[1] = f.bus.online[2] = false;
  f.clock.now = 1000;
  f.core.begin();
  f.output.reset();
  send(f.core, "RAW id=1 raw=1000");
  CHECK(f.output.contains("code=11"));  // torque not explicitly on yet

  send(f.core, "TORQUE 1 ON");
  CHECK(f.output.contains("OK torque=on"));
  // Enabling torque writes the present pose first, even without calibration,
  // so the servo cannot snap to a stale target.
  CHECK(f.bus.lastPos[0] == f.bus.raw[0]);

  f.output.reset();
  send(f.core, "RAW id=1 raw=1000 speed=10 acc=20");
  CHECK(f.output.contains("OK raw"));
  CHECK(f.bus.lastPos[0] == 1000);
  CHECK(f.bus.lastSpeed[0] == 114);
  CHECK(f.bus.lastAcc[0] == 20);
  CHECK(f.core.mode() == lt100::Mode::Motion);

  // Installation moves are one-shot like JOG: no LinkLost after the timeout.
  f.output.reset();
  f.clock.now += 400;
  f.core.tick();
  CHECK(f.core.mode() == lt100::Mode::Ready);
  CHECK(!f.output.contains("code=17"));

  // Raw range and parser limits.
  f.output.reset();
  send(f.core, "RAW id=1 raw=4096");
  CHECK(f.output.contains("code=2"));

  // More than one servo on the bus is rejected: installation is single-servo.
  Fixture g;
  g.clock.now = 1000;
  g.core.begin();
  send(g.core, "TORQUE 1 ON");
  g.output.reset();
  send(g.core, "RAW id=1 raw=1000");
  CHECK(g.output.contains("code=12"));

  // A joint with a calibration record must use JOG, not the unguarded RAW move.
  Fixture h;
  h.storage.has = true;
  h.storage.saved = makeCalibration();
  h.bus.online[1] = h.bus.online[2] = false;
  h.clock.now = 1000;
  h.core.begin();
  send(h.core, "TORQUE 1 ON");
  h.output.reset();
  send(h.core, "RAW id=1 raw=1000");
  CHECK(h.output.contains("code=11"));
}

void testCoreTorqueEnableSafety() {
  Fixture f;
  f.calibrateAll();  // ends with torque on, targets at the marked MAX raw
  send(f.core, "TORQUE all OFF");
  CHECK(f.core.torqueMask() == 0);

  // Enable first sets the target to the present pose, so a stale target
  // cannot snap the joint.
  f.bus.raw[0] = 2048;
  f.bus.raw[1] = 1500;
  f.bus.lastPos[0] = f.bus.lastPos[1] = 0;
  send(f.core, "TORQUE all ON");
  CHECK(f.core.torqueMask() == 0x07);
  CHECK(f.bus.lastPos[0] == 2048 && f.bus.lastPos[1] == 1500);
  CHECK(f.bus.lastSpeed[0] == 228);  // 20 deg/s

  // A calibrated joint moved by hand outside its travel refuses enable.
  send(f.core, "TORQUE all OFF");
  f.bus.raw[1] = 4095;
  f.output.reset();
  send(f.core, "TORQUE all ON");
  CHECK(f.output.contains("code=10"));
  CHECK(f.output.contains("joint=2"));
  CHECK(f.core.torqueMask() == 0);
  CHECK(!f.bus.lastTorque[0] && !f.bus.lastTorque[1] && !f.bus.lastTorque[2]);

  // Torque off must always be allowed, even outside the travel.
  f.output.reset();
  send(f.core, "TORQUE all OFF");
  CHECK(f.output.contains("OK torque=off"));

  // Back inside the travel, a single joint can be enabled alone.
  f.bus.raw[1] = 1234;
  f.output.reset();
  send(f.core, "TORQUE 2 ON");
  CHECK(f.output.contains("OK torque=on"));
  CHECK(f.core.torqueMask() == 0x02);
  CHECK(f.bus.lastPos[1] == 1234);
  CHECK(!f.bus.lastTorque[0] && f.bus.lastTorque[1] && !f.bus.lastTorque[2]);

  // If the hold write fails, do not enable torque at all.
  send(f.core, "TORQUE all OFF");
  f.bus.syncOk = false;
  f.output.reset();
  send(f.core, "TORQUE 1 ON");
  CHECK(f.output.contains("code=7"));
  CHECK(f.core.torqueMask() == 0);
  f.bus.syncOk = true;
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
  testWrapRange();
  testLimits();
  testProtocol();
  testCoreUncalibrated();
  testCoreCalibrationAndMotion();
  testCoreJogSingleJoint();
  testRawMoveInstallation();
  testCoreServoId();
  testCoreFaultOnOffline();
  testCoreCalibrationRules();
  testCoreCalibrationMarkOrder();
  testCoreStorageChecksum();
  testCoreLoadsCrossZeroButUnusable();
  testCoreStorageFailure();
  testCoreSyncFailure();
  testCoreTorqueEnableSafety();
  testCoreStreamAndState();

  if (g_failures != 0) {
    std::fprintf(stderr, "%d check(s) failed\n", g_failures);
    return 1;
  }
  std::printf("all checks passed\n");
  return 0;
}
