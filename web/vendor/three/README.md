# three.js 0.160.1 (r160)

本地 vendored，课堂离线使用；运行时不访问 CDN。

| 本地文件 | 来源 |
|---|---|
| `three.module.js` | `https://unpkg.com/three@0.160.1/build/three.module.js` |
| `OrbitControls.js` | `https://unpkg.com/three@0.160.1/examples/jsm/controls/OrbitControls.js` |
| `RoomEnvironment.js` | `https://unpkg.com/three@0.160.1/examples/jsm/environments/RoomEnvironment.js` |
| `LICENSE` | `https://unpkg.com/three@0.160.1/LICENSE` |

- 下载日期：2026-11-22
- 许可证：MIT（见 `LICENSE`，Copyright © 2010-2023 three.js authors）
- 版本核对：`three.module.js` 内 `REVISION = '160'`
- sha256：
  - `three.module.js` `76dea8151bc9352aef3528b4262e249b2604f62543828328db978d060d61a495`
  - `OrbitControls.js` `7aa4372a5ec60b49988edde81014c7361740a57962d032003ca33301c1f4edd5`
  - `RoomEnvironment.js` `e21f41b7ef2016f2984a5d27850b42dffa797a6a194a138e288b06576d765a7b`
  - `LICENSE` `852e0e8699169bf9f6fdc6bda3e682d078dcbc738b5d33e74df594721bff271d`

页面通过 `twin.html` 的 import map 把裸 `three` 解析到 `./vendor/three/three.module.js`；
`OrbitControls`/`RoomEnvironment` 保持原始的 `import ... from "three"`，不做改写。
