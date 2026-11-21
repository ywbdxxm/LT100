import test from "node:test";
import assert from "node:assert/strict";

import {
  calComplete,
  calDirCommand,
  calMarkCommand,
  calRefCommand,
  calSplitCommand,
  rawMoveCommand,
  endpointPose,
  formatQ,
  idSetCommand,
  jogCommand,
  parseCalLine,
  parseIdLine,
  parseError,
  parseHello,
  parseLimitsLine,
  parseState,
  poseCommand,
  qToRaw,
  rawInJoint,
  rawInSafe,
  rawToQ,
  safeQRange,
  safeRange,
  torqueCommand,
} from "../../../web/lt100-protocol.mjs";

const STATE_LINE =
  "STATE seq=42 mode=READY online=7 cal=7 torque=7 err=0 age=12 " +
  "q=20.0,0.0,-10.0 raw=2276,2048,1934 load=100,100,100 cur=20,20,20 " +
  "v=120 t=39,40,38";

test("parses HELLO", () => {
  const hello = parseHello(
    "HELLO protocol=1 fw=0.1.0 cal=1 features=state,stream,motion,cal,limits"
  );
  assert.equal(hello.protocol, 1);
  assert.equal(hello.fw, "0.1.0");
  assert.deepEqual(hello.features, [
    "state",
    "stream",
    "motion",
    "cal",
    "limits",
  ]);
});

test("parses STATE arrays and scalars", () => {
  const state = parseState(STATE_LINE);
  assert.equal(state.mode, "READY");
  assert.equal(state.online, 7);
  assert.equal(state.cal, 7);
  assert.equal(state.torque, 7);
  assert.equal(state.err, 0);
  assert.equal(state.age, 12);
  assert.deepEqual(state.q, [20, 0, -10]);
  assert.deepEqual(state.raw, [2276, 2048, 1934]);
  assert.deepEqual(state.load, [100, 100, 100]);
  assert.deepEqual(state.cur, [20, 20, 20]);
  assert.deepEqual(state.temp, [39, 40, 38]);
  assert.equal(state.v, 120);
});

test("parses ERR and CAL/LIMITS lines", () => {
  const err = parseError("ERR code=10 seq=42 joint=0 msg=outside_safe");
  assert.deepEqual(err, {
    code: 10,
    seq: 42,
    joint: 0,
    msg: "outside_safe",
  });

  const cal = parseCalLine(
    "CAL id=1 ref=1 min_set=1 max_set=1 zero_raw=2048 zero_q=90.0 sign=-1 " +
      "min=1000 max=3000 margin=40 valid=1"
  );
  assert.equal(cal.id, 1);
  assert.equal(cal.zeroQ, 90);
  assert.equal(cal.sign, -1);
  assert.equal(cal.valid, true);

  const limits = parseLimitsLine(
    "LIMITS id=1 min=1000 max=3000 safe=1040..2960 valid=1"
  );
  assert.equal(limits.safeMin, 1040);
  assert.equal(limits.safeMax, 2960);
  assert.equal(limits.valid, true);
});

test("raw/q conversion uses zero_q and direction", () => {
  const cal = {
    valid: true,
    zeroRaw: 2048,
    zeroQ: 90,
    sign: -1,
    minRaw: 1000,
    maxRaw: 3000,
    margin: 40,
  };
  assert.equal(rawToQ(cal, 2048), 90);
  const q = rawToQ(cal, 1024);
  assert.ok(Math.abs(q - 180) < 1e-9);
  assert.equal(qToRaw(cal, q), 1024);
  assert.equal(qToRaw(cal, 90), 2048);
  assert.deepEqual(safeRange(cal), { min: 1040, max: 2960, wrap: false });
});

test("supports raw ranges that cross 0", () => {
  const cal = {
    valid: true,
    zeroRaw: 100,
    zeroQ: 0,
    sign: 1,
    minRaw: 4000,
    maxRaw: 200,
    margin: 40,
  };
  assert.deepEqual(safeRange(cal), { min: 4040, max: 160, wrap: true });
  assert.equal(rawInSafe(safeRange(cal), 4050), true);
  assert.equal(rawInSafe(safeRange(cal), 100), true);
  assert.equal(rawInSafe(safeRange(cal), 500), false);
  const q = rawToQ(cal, 4090);
  assert.ok(q < 0 && Math.abs(q - -9.32) < 0.01);
  assert.equal(qToRaw(cal, -7), 20);
  assert.ok(Math.abs(rawToQ(cal, 20) - -7.03) < 0.01);
  assert.ok(190 > safeQRange(cal).max);  // outside the safe q interval

  // A calibrated arc longer than 180 degrees stays unambiguous.
  const wide = {
    valid: true,
    zeroRaw: 600,
    zeroQ: 0,
    sign: 1,
    minRaw: 500,
    maxRaw: 3000,
    margin: 40,
  };
  assert.ok(Math.abs(rawToQ(wide, 2700) - 184.57) < 0.05);
  assert.equal(qToRaw(wide, rawToQ(wide, 2700)), 2700);
  const qRange = safeQRange(wide);
  assert.ok(qRange.min < 0 && qRange.max > 180);
  assert.ok(-10 < qRange.min);  // -10 deg is outside the safe q interval
});

test("rawInJoint treats cross-0 travel circularly", () => {
  const cal = {
    valid: true,
    zeroRaw: 3500,
    zeroQ: 0,
    sign: 1,
    minRaw: 3098,
    maxRaw: 563,
    margin: 40,
  };
  // Travel is 3098 -> 4095 -> 0 -> 563 (span 1561).
  assert.equal(rawInJoint(cal, 3500), true);
  assert.equal(rawInJoint(cal, 200), true);
  assert.equal(rawInJoint(cal, 1000), false);
  assert.equal(rawInJoint(cal, 3137), true);  // inside travel, outside safe margin
  assert.equal(rawInJoint(cal, 3097), false);
  assert.deepEqual(safeRange(cal), { min: 3138, max: 523, wrap: true });
  assert.equal(rawInSafe(safeRange(cal), 3138), true);
  assert.equal(rawInSafe(safeRange(cal), 523), true);
  assert.equal(rawInSafe(safeRange(cal), 524), false);
  assert.equal(rawInSafe(safeRange(cal), 3137), false);
  assert.equal(rawToQ(cal, 3500), 0);
});

test("rejects incomplete calibration for conversion", () => {
  const cal = { valid: false, zeroRaw: 2048, zeroQ: 0, sign: 1 };
  assert.equal(rawToQ(cal, 2048), null);
  assert.equal(qToRaw(cal, 0), null);
  assert.equal(safeRange(cal), null);
  assert.equal(calComplete([cal, cal, cal]), false);
});

test("builds exact protocol commands", () => {
  assert.equal(
    poseCommand(7, [20.04, 0, -10], 10, 20),
    "POSE seq=7 q=20.0,0.0,-10.0 speed=10 acc=20"
  );
  assert.equal(
    jogCommand(9, 2, -12.54, 10, 20),
    "JOG seq=9 id=2 q=-12.5 speed=10 acc=20"
  );
  assert.equal(idSetCommand(3), "ID SET 3");
  assert.equal(parseIdLine("ID value=2").value, 2);
  assert.equal(torqueCommand(0, false), "TORQUE all OFF");
  assert.equal(torqueCommand(2, true), "TORQUE 2 ON");
  assert.equal(calRefCommand(1, -90.04), "CAL REF 1 -90.0");
  assert.equal(calDirCommand(2, -1), "CAL DIR 2 -1");
  assert.equal(calMarkCommand(3, "MAX"), "CAL MARK 3 MAX");
  assert.equal(calSplitCommand(1, "LOW"), "CAL SPLIT 1 LOW");
  assert.equal(calSplitCommand(2, "HIGH"), "CAL SPLIT 2 HIGH");
  assert.equal(rawMoveCommand(1, 2048, 10, 20), "RAW id=1 raw=2048 speed=10 acc=20");
  assert.throws(() => rawMoveCommand(1, 4096));
  assert.equal(formatQ(-0.04), "0.0");
});

test("endpointPose changes only the selected joint", () => {
  const cal = {
    valid: true,
    zeroRaw: 2048,
    zeroQ: 0,
    sign: 1,
    minRaw: 1000,
    maxRaw: 3000,
    margin: 40,
  };
  const cals = [cal, cal, cal];
  const state = parseState(STATE_LINE);
  const q = endpointPose(state, cals, 2, 1040);
  assert.equal(q.length, 3);
  assert.equal(q[0], 20);
  assert.equal(q[1], 0);
  assert.ok(Math.abs(q[2] - rawToQ(cal, 1040)) < 1e-9);
  assert.equal(endpointPose(state, [null, cal, cal], 0, 1040), null);
});
