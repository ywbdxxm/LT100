#include "lt100/core.h"

#include <cstdio>

#include "lt100/limits.h"

namespace lt100 {
namespace {

uint8_t bitFor(uint8_t joint) {
  return static_cast<uint8_t>(1u << (joint - 1));
}

bool isJoint(uint8_t joint) {
  return joint >= 1 && joint <= kJointCount;
}

}  // namespace

Core::Core(ServoBus& bus, Clock& clock, Storage& storage, Output& output)
    : bus_(bus), clock_(clock), storage_(storage), output_(output) {}

void Core::begin() {
  now_ = clock_.millis();
  lastReadMs_ = now_;
  lastStateMs_ = now_;
  lastPoseMs_ = now_;
  torqueKnown_ = false;
  torqueMask_ = 0;
  onlineMask_ = 0;
  previousOnlineMask_ = 0;
  stream_ = false;
  linkLost_ = false;
  lastError_ = Error::None;

  bool loaded = false;
  Calibration loadedCal;
  if (storage_.load(loadedCal)) {
    if (calibrationValidate(loadedCal) &&
        loadedCal.checksum == calibrationChecksum(loadedCal)) {
      cal_ = loadedCal;
      loaded = true;
    } else {
      cal_ = Calibration();
      lastError_ = Error::Storage;
    }
  }
  if (!loaded && lastError_ == Error::None) {
    cal_ = Calibration();
  }

  mode_ = calibrationComplete(cal_) ? Mode::Ready : Mode::Uncal;
  readAll();
}

void Core::handleLine(const char* line, size_t len) {
  now_ = clock_.millis();
  const ParseResult parsed = parseLine(line, len);
  if (!parsed.ok) {
    outputError(parsed.error);
    return;
  }
  dispatch(parsed.command);
}

void Core::tick() {
  now_ = clock_.millis();
  if (now_ - lastReadMs_ >= kStatePeriodMs) {
    lastReadMs_ = now_;
    readAll();
  }
  if (mode_ == Mode::Motion && now_ - lastPoseMs_ > kLinkTimeoutMs) {
    mode_ = Mode::Ready;
    if (!linkLost_) {
      linkLost_ = true;
      outputError(Error::LinkLost);
    }
  }
  if (stream_ && now_ - lastStateMs_ >= kStatePeriodMs) {
    lastStateMs_ = now_;
    outputState();
  }
}

void Core::dispatch(const Command& cmd) {
  switch (cmd.verb) {
    case Verb::Hello:
      outputHello();
      break;
    case Verb::State:
      outputState();
      break;
    case Verb::Stream:
      stream_ = cmd.on;
      lastStateMs_ = now_;
      outputOk(cmd.on ? "stream=on" : "stream=off");
      break;
    case Verb::Pose:
      handlePose(cmd);
      break;
    case Verb::Stop:
      if (mode_ == Mode::Fault || mode_ == Mode::Estop) {
        outputError(Error::BadMode);
        break;
      }
      if (mode_ == Mode::Motion) mode_ = Mode::Ready;
      linkLost_ = false;
      outputOk("stop");
      break;
    case Verb::Estop:
      mode_ = Mode::Estop;
      outputOk("estop");
      break;
    case Verb::Torque:
      handleTorque(cmd);
      break;
    case Verb::CalStatus:
      outputCalStatus();
      break;
    case Verb::CalRef:
    case Verb::CalDir:
    case Verb::CalMark:
    case Verb::CalSave:
    case Verb::CalClear:
      handleCal(cmd);
      break;
    case Verb::Limits:
      outputLimits();
      break;
    case Verb::Clear:
      handleClear();
      break;
    default:
      outputError(Error::UnknownCommand);
      break;
  }
}

void Core::handlePose(const Command& cmd) {
  if (mode_ == Mode::Fault || mode_ == Mode::Estop ||
      mode_ == Mode::Calibrating) {
    outputError(Error::BadMode, 0, cmd.seq);
    return;
  }
  if (!calibrationComplete(cal_)) {
    outputError(Error::Uncalibrated, 0, cmd.seq);
    return;
  }
  readAll();
  if (mode_ == Mode::Fault) return;
  if (onlineMask_ != 0x07) {
    outputError(Error::ServoOffline, 0, cmd.seq);
    return;
  }
  if (!torqueKnown_ || torqueMask_ != 0x07) {
    outputError(Error::BadMode, 0, cmd.seq);
    return;
  }

  int16_t raw[kJointCount] = {0, 0, 0};
  const Error check = checkPose(cal_, cmd.pose, cmd.speed, cmd.acc, raw);
  if (check != Error::None) {
    outputError(check, 0, cmd.seq);
    return;
  }

  const uint16_t tickSpeed =
      static_cast<uint16_t>(static_cast<float>(cmd.speed) * kTicksPerDegree + 0.5f);
  const uint8_t ids[kJointCount] = {1, 2, 3};
  uint16_t speeds[kJointCount] = {tickSpeed, tickSpeed, tickSpeed};
  uint8_t accs[kJointCount] = {cmd.acc, cmd.acc, cmd.acc};
  if (!bus_.syncWrite(ids, raw, speeds, accs)) {
    setFault(Error::NoAck);
    return;
  }

  mode_ = Mode::Motion;
  lastPoseMs_ = now_;
  lastSeq_ = cmd.hasSeq ? cmd.seq : ++seqFallback_;
  linkLost_ = false;
  lastError_ = Error::None;
}

void Core::handleTorque(const Command& cmd) {
  if (mode_ == Mode::Estop) {
    outputError(Error::BadMode, cmd.joint);
    return;
  }
  if (cmd.on && (mode_ == Mode::Fault || mode_ == Mode::Calibrating)) {
    outputError(Error::BadMode, cmd.joint);
    return;
  }

  Error firstError = Error::None;
  uint8_t firstJoint = 0;
  const uint8_t first = cmd.joint == 0 ? 1 : cmd.joint;
  const uint8_t last = cmd.joint == 0 ? kJointCount : cmd.joint;
  for (uint8_t id = first; id <= last; id++) {
    if (!bus_.torque(id, cmd.on)) {
      if (firstError == Error::None) {
        firstError = Error::NoAck;
        firstJoint = id;
      }
      continue;
    }
    const uint8_t bit = bitFor(id);
    if (cmd.on) {
      torqueMask_ |= bit;
    } else {
      torqueMask_ &= static_cast<uint8_t>(~bit);
    }
  }
  torqueKnown_ = true;

  if (!cmd.on && mode_ == Mode::Motion) {
    mode_ = Mode::Ready;
  }
  if (firstError != Error::None) {
    outputError(firstError, firstJoint);
    return;
  }
  outputOk(cmd.on ? "torque=on" : "torque=off");
}

void Core::handleCal(const Command& cmd) {
  if (cmd.verb == Verb::CalSave) {
    if (mode_ == Mode::Motion || mode_ == Mode::Fault ||
        mode_ == Mode::Estop) {
      outputError(Error::BadMode);
      return;
    }
    if (!calibrationValidate(cal_)) {
      outputError(Error::Endpoints);
      return;
    }
    calibrationSetChecksum(cal_);
    if (!storage_.save(cal_)) {
      outputError(Error::Storage);
      return;
    }
    mode_ = calibrationComplete(cal_) ? Mode::Ready : Mode::Uncal;
    outputOk("cal_saved");
    return;
  }
  if (cmd.verb == Verb::CalClear) {
    if (mode_ == Mode::Motion || mode_ == Mode::Fault ||
        mode_ == Mode::Estop) {
      outputError(Error::BadMode);
      return;
    }
    if (cmd.joint == 0) {
      cal_ = Calibration();
      if (!storage_.clear()) {
        outputError(Error::Storage);
        return;
      }
    } else if (isJoint(cmd.joint)) {
      cal_.joint[cmd.joint - 1] = JointCalibration();
      calibrationSetChecksum(cal_);
      if (!storage_.save(cal_)) {
        outputError(Error::Storage);
        return;
      }
    } else {
      outputError(Error::BadArgs, cmd.joint);
      return;
    }
    mode_ = calibrationComplete(cal_) ? Mode::Ready : Mode::Uncal;
    outputOk("cal_cleared");
    return;
  }

  if (!isJoint(cmd.joint)) {
    outputError(Error::BadArgs, cmd.joint);
    return;
  }
  if (mode_ == Mode::Estop || mode_ == Mode::Fault ||
      mode_ == Mode::Motion) {
    outputError(Error::BadMode, cmd.joint);
    return;
  }

  const uint8_t index = static_cast<uint8_t>(cmd.joint - 1);
  JointCalibration& joint = cal_.joint[index];

  const uint8_t bit = bitFor(cmd.joint);
  if (!torqueKnown_ || (torqueMask_ & bit) != 0) {
    outputError(Error::BadMode, cmd.joint);
    return;
  }

  if (cmd.verb == Verb::CalDir) {
    joint.sign = cmd.sign;
    calibrationSetChecksum(cal_);
    mode_ = Mode::Calibrating;
    outputOk("cal_dir");
    return;
  }

  int16_t raw = 0;
  if (!bus_.readRaw(cmd.joint, raw)) {
    outputError(Error::ServoOffline, cmd.joint);
    return;
  }
  if (raw < kRawMin || raw > kRawMax) {
    outputError(Error::Range, cmd.joint);
    return;
  }

  if (cmd.verb == Verb::CalRef) {
    joint.zeroRaw = raw;
    joint.zeroQ = cmd.q;
    joint.hasRef = true;
    calibrationSetChecksum(cal_);
    mode_ = Mode::Calibrating;
    outputOk("cal_ref");
    return;
  }

  if (cmd.verb == Verb::CalMark) {
    JointCalibration next = joint;
    if (cmd.mark < 0) {
      next.minRaw = raw;
      next.hasMin = true;
    } else {
      next.maxRaw = raw;
      next.hasMax = true;
    }
    if (next.hasMin && next.hasMax && !calibrationJointValid(next)) {
      outputError(Error::Endpoints, cmd.joint);
      return;
    }
    joint = next;
    calibrationSetChecksum(cal_);
    mode_ = Mode::Calibrating;
    outputOk(cmd.mark < 0 ? "cal_min" : "cal_max");
    return;
  }

  outputError(Error::UnknownCommand, cmd.joint);
}

void Core::handleClear() {
  if (mode_ == Mode::Fault || mode_ == Mode::Estop) {
    readAll();
    if (calibrationComplete(cal_) && onlineMask_ != 0x07) {
      outputError(Error::ServoOffline);
      return;
    }
    lastError_ = Error::None;
    linkLost_ = false;
    mode_ = calibrationComplete(cal_) ? Mode::Ready : Mode::Uncal;
    outputOk("cleared");
    return;
  }
  lastError_ = Error::None;
  linkLost_ = false;
  outputOk("clear");
}

void Core::readAll() {
  uint8_t mask = 0;
  for (uint8_t i = 0; i < kJointCount; i++) {
    ServoFeedback fb;
    const bool ok = bus_.feedback(static_cast<uint8_t>(i + 1), fb);
    online_[i] = ok;
    feedback_[i] = ok ? fb : ServoFeedback();
    if (ok) mask |= static_cast<uint8_t>(1u << i);
  }
  const uint8_t lost = static_cast<uint8_t>(previousOnlineMask_ & ~mask);
  onlineMask_ = mask;
  previousOnlineMask_ = mask;
  if (lost != 0 && mode_ != Mode::Fault && mode_ != Mode::Estop) {
    uint8_t joint = 1;
    while (joint <= kJointCount && (lost & bitFor(joint)) == 0) joint++;
    setFault(Error::ServoOffline, joint);
  }
}

void Core::setFault(Error error, uint8_t joint) {
  mode_ = Mode::Fault;
  lastError_ = error;
  outputError(error, joint);
}

void Core::outputError(Error error, uint8_t joint, uint32_t seq) {
  lastError_ = error;
  char line[192];
  std::snprintf(line, sizeof(line), "ERR code=%u seq=%lu joint=%u msg=%s",
                static_cast<unsigned>(error),
                static_cast<unsigned long>(seq),
                static_cast<unsigned>(joint), errorName(error));
  output_.line(line);
}

void Core::outputState() {
  char q[48];
  char raw[32];
  char load[32];
  char cur[32];
  char temp[32];
  int qn = 0;
  int rn = 0;
  int ln = 0;
  int cn = 0;
  int tn = 0;
  for (uint8_t i = 0; i < kJointCount; i++) {
    const float deg = cal_.joint[i].hasRef && online_[i]
                          ? rawToQ(cal_.joint[i], feedback_[i].raw)
                          : 0.0f;
    qn += std::snprintf(q + qn, sizeof(q) - qn, i ? ",%.1f" : "%.1f",
                        static_cast<double>(deg));
    rn += std::snprintf(raw + rn, sizeof(raw) - rn, i ? ",%d" : "%d",
                        online_[i] ? feedback_[i].raw : 0);
    ln += std::snprintf(load + ln, sizeof(load) - ln, i ? ",%d" : "%d",
                        online_[i] ? feedback_[i].load : 0);
    cn += std::snprintf(cur + cn, sizeof(cur) - cn, i ? ",%d" : "%d",
                        online_[i] ? feedback_[i].current : 0);
    tn += std::snprintf(temp + tn, sizeof(temp) - tn, i ? ",%d" : "%d",
                        online_[i] ? feedback_[i].temp : 0);
  }

  int voltage = 0;
  for (uint8_t i = 0; i < kJointCount; i++) {
    if (online_[i]) {
      voltage = feedback_[i].voltage;
      break;
    }
  }

  char line[320];
  std::snprintf(line, sizeof(line),
                "STATE seq=%lu mode=%s online=%u cal=%u torque=%u err=%u age=%lu "
                "q=%s raw=%s load=%s cur=%s v=%d t=%s",
                static_cast<unsigned long>(lastSeq_), modeName(),
                static_cast<unsigned>(onlineMask_),
                static_cast<unsigned>(calibrationValidMask(cal_)),
                static_cast<unsigned>(torqueMask_),
                static_cast<unsigned>(lastError_),
                static_cast<unsigned long>(now_ - lastReadMs_),
                q, raw, load, cur, voltage, temp);
  output_.line(line);
}

void Core::outputHello() {
  char line[160];
  std::snprintf(line, sizeof(line),
                "HELLO protocol=%u fw=%s cal=%u "
                "features=state,stream,motion,cal,limits",
                static_cast<unsigned>(kProtocolVersion), kFirmwareVersion, 1u);
  output_.line(line);
}

void Core::outputCalStatus() {
  for (uint8_t i = 0; i < kJointCount; i++) {
    const JointCalibration& j = cal_.joint[i];
    char line[192];
    std::snprintf(line, sizeof(line),
                  "CAL id=%u ref=%u min_set=%u max_set=%u zero_raw=%d zero_q=%.1f "
                  "sign=%d min=%d max=%d margin=%u valid=%u",
                  static_cast<unsigned>(i + 1), j.hasRef ? 1u : 0u,
                  j.hasMin ? 1u : 0u, j.hasMax ? 1u : 0u, j.zeroRaw,
                  static_cast<double>(j.zeroQ), j.sign, j.minRaw, j.maxRaw,
                  static_cast<unsigned>(j.margin),
                  calibrationJointValid(j) ? 1u : 0u);
    output_.line(line);
  }
  outputOk("cal");
}

void Core::outputLimits() {
  for (uint8_t i = 0; i < kJointCount; i++) {
    const JointCalibration& j = cal_.joint[i];
    const int safeMin = static_cast<int>(j.minRaw) + static_cast<int>(j.margin);
    const int safeMax = static_cast<int>(j.maxRaw) - static_cast<int>(j.margin);
    char line[160];
    std::snprintf(line, sizeof(line),
                  "LIMITS id=%u min=%d max=%d safe=%d..%d valid=%u",
                  static_cast<unsigned>(i + 1), j.minRaw, j.maxRaw, safeMin,
                  safeMax, calibrationJointValid(j) ? 1u : 0u);
    output_.line(line);
  }
  outputOk("limits");
}

void Core::outputOk(const char* text) {
  char line[128];
  std::snprintf(line, sizeof(line), "OK %s", text);
  output_.line(line);
}

const char* Core::modeName() const {
  switch (mode_) {
    case Mode::Boot: return "BOOT";
    case Mode::Uncal: return "UNCAL";
    case Mode::Calibrating: return "CAL";
    case Mode::Ready: return "READY";
    case Mode::Motion: return "MOTION";
    case Mode::Fault: return "FAULT";
    case Mode::Estop: return "ESTOP";
    default: return "?";
  }
}

const char* Core::errorName(Error error) const {
  switch (error) {
    case Error::None: return "none";
    case Error::UnknownCommand: return "unknown_command";
    case Error::BadArgs: return "bad_args";
    case Error::Range: return "range";
    case Error::LineTooLong: return "line_too_long";
    case Error::ServoOffline: return "servo_offline";
    case Error::NoAck: return "no_ack";
    case Error::Endpoints: return "endpoints";
    case Error::Uncalibrated: return "uncalibrated";
    case Error::OutsideSafe: return "outside_safe";
    case Error::BadMode: return "bad_mode";
    case Error::Busy: return "busy";
    case Error::Protocol: return "protocol";
    case Error::Storage: return "storage";
    case Error::OverTemp: return "over_temp";
    case Error::UnderVolt: return "under_volt";
    case Error::LinkLost: return "link_lost";
    case Error::Internal: return "internal";
    default: return "?";
  }
}

}  // namespace lt100
