#include "lt100/protocol.h"

#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

namespace lt100 {
namespace {

bool ieq(const char* a, const char* b) {
  while (*a && *b) {
    if (tolower(static_cast<unsigned char>(*a)) !=
        tolower(static_cast<unsigned char>(*b))) {
      return false;
    }
    a++;
    b++;
  }
  return *a == 0 && *b == 0;
}

bool keyValue(const char* token, const char* key, const char*& value) {
  const size_t n = strlen(key);
  for (size_t i = 0; i < n; i++) {
    if (tolower(static_cast<unsigned char>(token[i])) !=
        tolower(static_cast<unsigned char>(key[i]))) {
      return false;
    }
  }
  if (token[n] != '=') return false;
  value = token + n + 1;
  return true;
}

bool parseU32(const char* s, uint32_t& out) {
  if (!s || !*s) return false;
  char* end = nullptr;
  const unsigned long v = strtoul(s, &end, 10);
  if (end == s || *end != 0) return false;
  out = static_cast<uint32_t>(v);
  return true;
}

bool parseFloat(const char* s, float& out) {
  if (!s || !*s) return false;
  char* end = nullptr;
  const float v = strtof(s, &end);
  if (end == s || *end != 0) return false;
  if (!(v > -1.0e6f && v < 1.0e6f)) return false;
  out = v;
  return true;
}

bool parseJoint(const char* s, uint8_t& out, bool allowAll) {
  if (!s) return false;
  if (allowAll && ieq(s, "all")) {
    out = 0;
    return true;
  }
  uint32_t v = 0;
  if (!parseU32(s, v) || v < 1 || v > kJointCount) return false;
  out = static_cast<uint8_t>(v);
  return true;
}

bool parseOnOff(const char* s, bool& out) {
  if (!s) return false;
  if (ieq(s, "on")) {
    out = true;
    return true;
  }
  if (ieq(s, "off")) {
    out = false;
    return true;
  }
  return false;
}

bool parseSign(const char* s, int8_t& out) {
  if (!s) return false;
  if (ieq(s, "+1") || strcmp(s, "1") == 0) {
    out = 1;
    return true;
  }
  if (ieq(s, "-1")) {
    out = -1;
    return true;
  }
  return false;
}

bool parseQList(const char* s, Pose& pose) {
  if (!s || !*s) return false;
  char buf[64];
  if (strlen(s) >= sizeof(buf)) return false;
  memcpy(buf, s, strlen(s) + 1);
  char* parts[4] = {nullptr, nullptr, nullptr, nullptr};
  uint8_t count = 0;
  char* p = buf;
  while (p && count < 4) {
    parts[count++] = p;
    p = strchr(p, ',');
    if (p) *p++ = 0;
  }
  if (count != kJointCount) return false;
  for (uint8_t i = 0; i < kJointCount; i++) {
    if (!parseFloat(parts[i], pose.q[i])) return false;
  }
  return true;
}

ParseResult fail(Error error) {
  ParseResult r;
  r.ok = false;
  r.error = error;
  return r;
}

}  // namespace

ParseResult parseLine(const char* line, size_t len) {
  if (!line) return fail(Error::BadArgs);
  if (len > kMaxLine) return fail(Error::LineTooLong);

  char buf[kMaxLine + 1];
  memcpy(buf, line, len);
  buf[len] = 0;

  char* tokens[12] = {nullptr};
  uint8_t count = 0;
  char* p = buf;
  while (*p) {
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (!*p) break;
    if (count >= 12) return fail(Error::BadArgs);
    tokens[count++] = p;
    while (*p && *p != ' ' && *p != '\t' && *p != '\r' && *p != '\n') p++;
    if (!*p) break;
    *p++ = 0;
  }
  if (count == 0) return fail(Error::BadArgs);

  ParseResult result;
  result.ok = true;
  result.error = Error::None;
  Command& cmd = result.command;

  if (ieq(tokens[0], "HELLO")) {
    if (count != 1) return fail(Error::BadArgs);
    cmd.verb = Verb::Hello;
  } else if (ieq(tokens[0], "STATE")) {
    if (count != 1) return fail(Error::BadArgs);
    cmd.verb = Verb::State;
  } else if (ieq(tokens[0], "STREAM")) {
    if (count != 2 || !parseOnOff(tokens[1], cmd.on)) return fail(Error::BadArgs);
    cmd.verb = Verb::Stream;
  } else if (ieq(tokens[0], "POSE")) {
    cmd.verb = Verb::Pose;
    bool hasQ = false;
    for (uint8_t i = 1; i < count; i++) {
      const char* value = nullptr;
      if (keyValue(tokens[i], "seq", value)) {
        if (!parseU32(value, cmd.seq)) return fail(Error::BadArgs);
        cmd.hasSeq = true;
      } else if (keyValue(tokens[i], "q", value)) {
        if (!parseQList(value, cmd.pose)) return fail(Error::BadArgs);
        hasQ = true;
      } else if (keyValue(tokens[i], "speed", value)) {
        uint32_t v = 0;
        if (!parseU32(value, v) || v > 0xffffu) return fail(Error::BadArgs);
        cmd.speed = static_cast<uint16_t>(v);
      } else if (keyValue(tokens[i], "acc", value)) {
        uint32_t v = 0;
        if (!parseU32(value, v) || v > 0xffu) return fail(Error::BadArgs);
        cmd.acc = static_cast<uint8_t>(v);
      } else {
        return fail(Error::BadArgs);
      }
    }
    if (!hasQ) return fail(Error::BadArgs);
  } else if (ieq(tokens[0], "STOP")) {
    if (count != 1) return fail(Error::BadArgs);
    cmd.verb = Verb::Stop;
  } else if (ieq(tokens[0], "ESTOP")) {
    if (count != 1) return fail(Error::BadArgs);
    cmd.verb = Verb::Estop;
  } else if (ieq(tokens[0], "TORQUE")) {
    if (count != 3) return fail(Error::BadArgs);
    if (!parseJoint(tokens[1], cmd.joint, true)) return fail(Error::BadArgs);
    if (!parseOnOff(tokens[2], cmd.on)) return fail(Error::BadArgs);
    cmd.verb = Verb::Torque;
  } else if (ieq(tokens[0], "CAL")) {
    if (count < 2) return fail(Error::BadArgs);
    if (ieq(tokens[1], "STATUS")) {
      if (count != 2) return fail(Error::BadArgs);
      cmd.verb = Verb::CalStatus;
    } else if (ieq(tokens[1], "SAVE")) {
      if (count != 2) return fail(Error::BadArgs);
      cmd.verb = Verb::CalSave;
    } else if (ieq(tokens[1], "CLEAR")) {
      if (count != 3 || !parseJoint(tokens[2], cmd.joint, true)) return fail(Error::BadArgs);
      cmd.verb = Verb::CalClear;
    } else if (ieq(tokens[1], "REF")) {
      if (count != 4 || !parseJoint(tokens[2], cmd.joint, false) ||
          !parseFloat(tokens[3], cmd.q)) {
        return fail(Error::BadArgs);
      }
      cmd.verb = Verb::CalRef;
    } else if (ieq(tokens[1], "DIR")) {
      if (count != 4 || !parseJoint(tokens[2], cmd.joint, false) ||
          !parseSign(tokens[3], cmd.sign)) {
        return fail(Error::BadArgs);
      }
      cmd.verb = Verb::CalDir;
    } else if (ieq(tokens[1], "MARK")) {
      if (count != 4 || !parseJoint(tokens[2], cmd.joint, false)) {
        return fail(Error::BadArgs);
      }
      if (ieq(tokens[3], "MIN")) {
        cmd.mark = -1;
      } else if (ieq(tokens[3], "MAX")) {
        cmd.mark = 1;
      } else {
        return fail(Error::BadArgs);
      }
      cmd.verb = Verb::CalMark;
    } else {
      return fail(Error::UnknownCommand);
    }
  } else if (ieq(tokens[0], "LIMITS")) {
    if (count != 1) return fail(Error::BadArgs);
    cmd.verb = Verb::Limits;
  } else if (ieq(tokens[0], "CLEAR")) {
    if (count != 1) return fail(Error::BadArgs);
    cmd.verb = Verb::Clear;
  } else {
    return fail(Error::UnknownCommand);
  }

  return result;
}

}  // namespace lt100
