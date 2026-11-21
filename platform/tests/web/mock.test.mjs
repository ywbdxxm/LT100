import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMockTransport } from "../../../web/arm/mock.mjs";
import { parseError, parseState } from "../../../web/lt100-protocol.mjs";

const machine = JSON.parse(
  readFileSync(new URL("../../../web/arm/machine.json", import.meta.url), "utf8")
);

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function open(t) {
  mock.timers.enable({ apis: ["setInterval"] });
  const lines = [];
  const transport = createMockTransport(machine);
  transport.onLine((line) => lines.push(line));
  await transport.connect();
  t.after(() => {
    transport.close();
    mock.timers.reset();
  });
  return { transport, lines };
}

const lastState = (lines) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const state = parseState(lines[i]);
    if (state) return state;
  }
  return null;
};

test("mock：HELLO 与 STREAM ON 回 OK stream=on + STATE", async (t) => {
  const { transport, lines } = await open(t);

  transport.send("HELLO");
  await flush();
  assert.match(
    lines[0],
    /^HELLO protocol=1 fw=0\.1\.0-mock cal=1 features=state,stream,motion,cal,limits$/
  );

  lines.length = 0;
  transport.send("STREAM ON");
  await flush();
  assert.equal(lines[0], "OK stream=on");
  const state = parseState(lines[1]);
  assert.ok(state, "STREAM ON 后应跟一条 STATE");
  assert.equal(state.seq, 0);
  assert.equal(state.torque, 7);
});

test("mock：CAL STATUS / LIMITS 各 3 条后回 OK", async (t) => {
  const { transport, lines } = await open(t);

  transport.send("CAL STATUS");
  await flush();
  assert.equal(lines.filter((line) => line.startsWith("CAL id=")).length, 3);
  assert.ok(lines.slice(0, 3).every((line) => /valid=1 wrap=0$/.test(line)));
  assert.equal(lines.at(-1), "OK cal");

  lines.length = 0;
  transport.send("LIMITS");
  await flush();
  assert.equal(lines.filter((line) => line.startsWith("LIMITS id=")).length, 3);
  assert.equal(lines.at(-1), "OK limits");
});

test("mock：STATE.seq 跟随最近接受的 POSE，不随 tick 自增", async (t) => {
  const { transport, lines } = await open(t);
  transport.send("STREAM ON");
  await flush();

  lines.length = 0;
  mock.timers.tick(100);
  await flush();
  assert.equal(lastState(lines).seq, 0);

  transport.send("POSE seq=7 q=0,0,0 speed=25 acc=20");
  await flush();
  lines.length = 0;
  mock.timers.tick(100);
  await flush();
  assert.equal(lastState(lines).seq, 7);

  transport.send("POSE seq=12 q=1,0,0 speed=25 acc=20");
  await flush();
  lines.length = 0;
  mock.timers.tick(200);
  await flush();
  assert.equal(lastState(lines).seq, 12);
});

test("mock：TORQUE 回 OK 并在 STATE 反映", async (t) => {
  const { transport, lines } = await open(t);
  transport.send("STREAM ON");
  await flush();

  lines.length = 0;
  transport.send("TORQUE all OFF");
  await flush();
  assert.equal(lines[0], "OK torque=off");
  assert.equal(parseState(lines[1]).torque, 0);

  lines.length = 0;
  transport.send("TORQUE all ON");
  await flush();
  assert.equal(lines[0], "OK torque=on");
  assert.equal(parseState(lines[1]).torque, 7);
});

test("mock：力矩关时 POSE 回 ERR 11，不运动不更新 seq", async (t) => {
  const { transport, lines } = await open(t);
  transport.send("STREAM ON");
  await flush();
  transport.send("TORQUE all OFF");
  await flush();
  const before = transport.state.actual;

  lines.length = 0;
  transport.send("POSE seq=3 q=0,0,0 speed=25 acc=20");
  await flush();
  const error = parseError(lines[0]);
  assert.ok(error);
  assert.equal(error.code, 11);
  assert.equal(error.msg, "bad_mode");

  mock.timers.tick(300);
  await flush();
  const after = transport.state.actual;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(after[i] - before[i]) < 1e-9);
  assert.equal(lastState(lines).seq, 0);
});

test("mock：越界 POSE 回 ERR 10，不运动不更新 seq", async (t) => {
  const { transport, lines } = await open(t);
  transport.send("STREAM ON");
  await flush();
  const before = transport.state.actual;

  lines.length = 0;
  transport.send("POSE seq=5 q=999,0,0 speed=25 acc=20");
  await flush();
  const error = parseError(lines[0]);
  assert.ok(error);
  assert.equal(error.code, 10);
  assert.equal(error.msg, "outside_safe");

  mock.timers.tick(300);
  await flush();
  const after = transport.state.actual;
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(after[i] - before[i]) < 1e-9);
  assert.equal(lastState(lines).seq, 0);
});
