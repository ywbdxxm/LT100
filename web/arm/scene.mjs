// Three.js stage: renderer, camera, orbit controls, lights, table.
import * as THREE from "three";
import { OrbitControls } from "../vendor/three/OrbitControls.js";
import { RoomEnvironment } from "../vendor/three/RoomEnvironment.js";

export function createScene(canvas, machine) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14100d);
  scene.fog = new THREE.Fog(0x14100d, 1800, 3600);

  const camera = new THREE.PerspectiveCamera(36, 1, 5, 6000);
  camera.position.set(760, 470, 980);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 250, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 350;
  controls.maxDistance = 2400;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.update();

  scene.add(new THREE.HemisphereLight(0x8d8377, 0x2a1d14, 0.55));

  const key = new THREE.DirectionalLight(0xffd9b2, 2.5);
  key.position.set(520, 940, 720);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 100;
  key.shadow.camera.far = 2600;
  key.shadow.camera.left = -750;
  key.shadow.camera.right = 750;
  key.shadow.camera.top = 900;
  key.shadow.camera.bottom = -200;
  key.shadow.bias = -0.0008;
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x7fa8ff, 0.45);
  rim.position.set(-640, 420, -760);
  scene.add(rim);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envTarget.texture;

  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardMaterial({ color: 0x251d17, roughness: 0.94, metalness: 0.04 })
  );
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  scene.add(table);

  const contact = new THREE.Mesh(
    new THREE.CircleGeometry(machine.base.radius * 1.75, 48),
    new THREE.MeshBasicMaterial({ color: 0x0a0806, transparent: true, opacity: 0.5 })
  );
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.4;
  scene.add(contact);

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const render = () => {
    controls.update();
    renderer.render(scene, camera);
  };

  const dispose = () => {
    observer.disconnect();
    controls.dispose();
    envTarget.dispose();
    pmrem.dispose();
    renderer.dispose();
  };

  return { scene, camera, controls, renderer, render, resize, dispose };
}
