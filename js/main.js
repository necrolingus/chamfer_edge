import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

import { analyzeMeshTopology, getGroupSegmentIds } from './topology.js';
import {
  initCSGEngine,
  buildOperationMeshes,
  applyEdgeOperationsCSG,
} from './chamferEngine.js';
import { createSampleModel } from './sampleModels.js';

// Application State
const state = {
  theme: localStorage.getItem('edgecraft-theme') || 'light',
  modelName: 'L_Bracket_With_Hole.stl',
  originalGeometry: null,
  currentGeometry: null,
  topology: null,

  selectionMode: 'smart',
  creaseAngleDeg: 25,
  filterConvex: true,
  filterConcave: true,
  selectedSegmentIds: new Set(),
  hoveredSegmentIds: new Set(),
  hoveredLeadSegId: null,

  opType: 'chamfer',
  size1: 2.0,
  size2: 2.0,
  asymmetric: false,
  flipAsymmetric: false,
  filletSegments: 12,
  endpointMode: 'smart',

  showWireframe: false,
  showLivePreview: true,
  showEdges: true,

  history: [],
  historyIndex: -1,
  isApplying: false,
};

const dom = {
  canvasContainer: document.getElementById('canvas-container'),
  viewportWrapper: document.getElementById('viewport-wrapper'),
  dropOverlay: document.getElementById('drop-overlay'),
  edgeTooltip: document.getElementById('edge-tooltip'),
  fileInput: document.getElementById('stl-file-input'),
  sampleSelect: document.getElementById('sample-select'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnResetModel: document.getElementById('btn-reset-model'),
  btnExportStl: document.getElementById('btn-export-stl'),
  engineStatus: document.getElementById('engine-status'),
  engineStatusText: document.getElementById('engine-status-text'),

  btnThemeToggle: document.getElementById('btn-theme-toggle'),
  themeIcon: document.getElementById('theme-icon'),
  themeLabel: document.getElementById('theme-label'),
  btnOpenLibraries: document.getElementById('btn-open-libraries'),
  librariesModal: document.getElementById('libraries-modal'),
  btnCloseLibraries: document.getElementById('btn-close-libraries'),
  btnDoneLibraries: document.getElementById('btn-done-libraries'),

  segModeBtns: document.querySelectorAll('[data-select-mode]'),
  selectionModeHint: document.getElementById('selection-mode-hint'),
  creaseSlider: document.getElementById('crease-angle-slider'),
  creaseVal: document.getElementById('crease-angle-val'),
  filterConvex: document.getElementById('filter-convex'),
  filterConcave: document.getElementById('filter-concave'),

  selectedCount: document.getElementById('selected-count'),
  selectedTypes: document.getElementById('selected-types'),
  btnClearSelection: document.getElementById('btn-clear-selection'),
  btnInvertSelection: document.getElementById('btn-invert-selection'),
  totalEdgesBadge: document.getElementById('total-edges-badge'),
  selectedEdgesList: document.getElementById('selected-edges-list'),

  infoDimensions: document.getElementById('info-dimensions'),
  infoTriangles: document.getElementById('info-triangles'),
  infoManifold: document.getElementById('info-manifold'),

  btnFitView: document.getElementById('btn-fit-view'),
  btnToggleWireframe: document.getElementById('btn-toggle-wireframe'),
  btnTogglePreview: document.getElementById('btn-toggle-preview'),
  btnToggleEdges: document.getElementById('btn-toggle-edges'),

  opCards: document.querySelectorAll('[data-op-type]'),
  sizeLabel: document.getElementById('size-label'),
  sizeInput: document.getElementById('chamfer-size-input'),
  sizeSlider: document.getElementById('chamfer-size-slider'),
  presetBtns: document.querySelectorAll('.preset-btn'),

  chamferSymmetryGroup: document.getElementById('chamfer-symmetry-group'),
  asymmetricToggle: document.getElementById('asymmetric-toggle'),
  asymmetricControls: document.getElementById('asymmetric-controls'),
  size2Input: document.getElementById('chamfer-size2-input'),
  size2Slider: document.getElementById('chamfer-size2-slider'),
  btnFlipAsymmetric: document.getElementById('btn-flip-asymmetric'),

  filletSegmentsGroup: document.getElementById('fillet-segments-group'),
  filletSegmentsSlider: document.getElementById('fillet-segments-slider'),
  filletSegmentsVal: document.getElementById('fillet-segments-val'),

  endpointModeSelect: document.getElementById('endpoint-mode-select'),
  btnApplyOp: document.getElementById('btn-apply-op'),
  btnApplyText: document.getElementById('btn-apply-text'),
  opHistoryCount: document.getElementById('op-history-count'),
  opHistoryList: document.getElementById('op-history-list'),
  toastContainer: document.getElementById('toast-container'),
};

let scene, camera, renderer, controls;
let modelMesh = null;
let wireframeMesh = null;
let featureLinesMesh = null;
let highlightTubesGroup = null;
let previewMesh = null;
let gridHelper = null;

const raycaster = new THREE.Raycaster();
const pointerNDC = new THREE.Vector2();
let pointerDownPos = { x: 0, y: 0 };

const COLOR_CONVEX_DARK = new THREE.Color(0x38bdf8);
const COLOR_CONVEX_LIGHT = new THREE.Color(0x0284c7);
const COLOR_CONCAVE_DARK = new THREE.Color(0xf472b6);
const COLOR_CONCAVE_LIGHT = new THREE.Color(0xdb2777);
const COLOR_SELECTED = new THREE.Color(0xf59e0b);
const COLOR_HOVER = new THREE.Color(0x10b981);

async function init() {
  initThreeScene();
  applyTheme(state.theme);
  bindUIEvents();

  initCSGEngine().then((wasm) => {
    const dot = dom.engineStatus.querySelector('.status-dot');
    if (wasm) {
      dot.classList.remove('loading');
      dot.classList.add('ready');
      dom.engineStatusText.textContent = 'Manifold CSG Ready';
    } else {
      dom.engineStatusText.textContent = 'CSG Unavailable';
    }
  });

  await loadSample('l-bracket');
  animate();
}

function applyTheme(theme) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', state.theme);
  try {
    localStorage.setItem('edgecraft-theme', state.theme);
  } catch (_) {}

  const isDark = state.theme === 'dark';
  if (dom.themeIcon) dom.themeIcon.textContent = isDark ? '☀️' : '🌙';
  if (dom.themeLabel) dom.themeLabel.textContent = isDark ? 'Light' : 'Dark';

  if (modelMesh && modelMesh.material) {
    modelMesh.material.color.setHex(isDark ? 0x475569 : 0x94a3b8);
  }

  if (scene && gridHelper) {
    const prevY = gridHelper.position.y;
    scene.remove(gridHelper);
    gridHelper.geometry.dispose();
    if (Array.isArray(gridHelper.material)) {
      gridHelper.material.forEach((m) => m.dispose());
    } else if (gridHelper.material) {
      gridHelper.material.dispose();
    }
    gridHelper = new THREE.GridHelper(
      160,
      16,
      isDark ? 0x334155 : 0x94a3b8,
      isDark ? 0x1e293b : 0xcbd5e1
    );
    gridHelper.position.y = prevY;
    scene.add(gridHelper);
  }

  rebuildFeatureEdgeLines();
  rebuildHighlightTubes();
}

function initThreeScene() {
  scene = new THREE.Scene();

  const width = dom.canvasContainer.clientWidth || 800;
  const height = dom.canvasContainer.clientHeight || 600;

  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 5000);
  camera.position.set(65, 52, 75);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  dom.canvasContainer.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;

  const ambientLight = new THREE.AmbientLight(0xdbeafe, 0.78);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
  keyLight.position.set(80, 120, 90);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x93c5fd, 0.65);
  fillLight.position.set(-90, 50, -60);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xfde68a, 0.4);
  rimLight.position.set(0, -100, 50);
  scene.add(rimLight);

  gridHelper = new THREE.GridHelper(160, 16, 0x94a3b8, 0xcbd5e1);
  gridHelper.position.y = -25;
  scene.add(gridHelper);

  highlightTubesGroup = new THREE.Group();
  scene.add(highlightTubesGroup);

  window.addEventListener('resize', onWindowResize);
}

function onWindowResize() {
  if (!dom.canvasContainer || !renderer || !camera) return;
  const w = dom.canvasContainer.clientWidth;
  const h = dom.canvasContainer.clientHeight;
  if (w === 0 || h === 0) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

function setBaseModelGeometry(geometry, name = 'Model.stl') {
  state.modelName = name;
  const cleanGeo = prepareLoadedGeometry(geometry);
  state.originalGeometry = cleanGeo.clone();

  state.history = [
    {
      geometry: cleanGeo.clone(),
      label: `Loaded ${name}`,
      opCount: 0,
    },
  ];
  state.historyIndex = 0;

  applyGeometryState(cleanGeo, true);
  updateHistoryUI();
}

function prepareLoadedGeometry(rawGeo) {
  const geo = rawGeo.index ? rawGeo.toNonIndexed() : rawGeo.clone();
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const center = new THREE.Vector3();
  box.getCenter(center);
  geo.translate(-center.x, -center.y, -center.z);
  geo.computeBoundingBox();
  geo.computeVertexNormals();
  return geo;
}

function applyGeometryState(geometry, fitCamera = false) {
  state.currentGeometry = geometry;
  state.selectedSegmentIds.clear();
  state.hoveredSegmentIds.clear();
  state.hoveredLeadSegId = null;

  if (modelMesh) {
    scene.remove(modelMesh);
    modelMesh.geometry.dispose();
    modelMesh.material.dispose();
    modelMesh = null;
  }
  if (wireframeMesh) {
    scene.remove(wireframeMesh);
    wireframeMesh.geometry.dispose();
    wireframeMesh.material.dispose();
    wireframeMesh = null;
  }

  const isDark = state.theme === 'dark';
  const mat = new THREE.MeshStandardMaterial({
    color: isDark ? 0x475569 : 0x94a3b8,
    roughness: 0.42,
    metalness: 0.12,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1.5,
    polygonOffsetUnits: 2.0,
  });
  modelMesh = new THREE.Mesh(geometry, mat);
  scene.add(modelMesh);

  const wireGeo = new THREE.WireframeGeometry(geometry);
  const wireMat = new THREE.LineBasicMaterial({
    color: isDark ? 0x94a3b8 : 0x475569,
    transparent: true,
    opacity: 0.25,
    depthTest: true,
  });
  wireframeMesh = new THREE.LineSegments(wireGeo, wireMat);
  wireframeMesh.visible = state.showWireframe;
  scene.add(wireframeMesh);

  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  if (gridHelper && bb) {
    gridHelper.position.y = bb.min.y - 0.2;
  }

  rebuildTopology();

  if (fitCamera) {
    fitCameraToModel();
  }
}

function rebuildTopology() {
  if (!state.currentGeometry) return;

  state.topology = analyzeMeshTopology(state.currentGeometry, state.creaseAngleDeg);
  state.selectedSegmentIds.clear();
  state.hoveredSegmentIds.clear();

  rebuildFeatureEdgeLines();
  rebuildHighlightTubes();
  updateLivePreviewMesh();
  updateSelectionUI();
  updateModelInfoUI();
}

function rebuildFeatureEdgeLines() {
  if (featureLinesMesh) {
    scene.remove(featureLinesMesh);
    featureLinesMesh.geometry.dispose();
    featureLinesMesh.material.dispose();
    featureLinesMesh = null;
  }

  if (!state.topology) return;

  const isDark = state.theme === 'dark';
  const convexColor = isDark ? COLOR_CONVEX_DARK : COLOR_CONVEX_LIGHT;
  const concaveColor = isDark ? COLOR_CONCAVE_DARK : COLOR_CONCAVE_LIGHT;

  const { segments } = state.topology;
  const positions = [];
  const colors = [];

  for (const seg of segments) {
    if (seg.type === 'convex' && !state.filterConvex) continue;
    if (seg.type === 'concave' && !state.filterConcave) continue;

    positions.push(seg.pA.x, seg.pA.y, seg.pA.z, seg.pB.x, seg.pB.y, seg.pB.z);

    let c = seg.type === 'convex' ? convexColor : concaveColor;
    if (state.selectedSegmentIds.has(seg.id)) {
      c = COLOR_SELECTED;
    } else if (state.hoveredSegmentIds.has(seg.id)) {
      c = COLOR_HOVER;
    }

    colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  lineGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.95,
  });

  featureLinesMesh = new THREE.LineSegments(lineGeo, lineMat);
  featureLinesMesh.visible = state.showEdges;
  scene.add(featureLinesMesh);
}

function rebuildHighlightTubes() {
  while (highlightTubesGroup.children.length > 0) {
    const child = highlightTubesGroup.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) child.material.dispose();
  }

  if (!state.topology || !state.showEdges || !state.currentGeometry) return;

  state.currentGeometry.computeBoundingSphere();
  const modelRadius = state.currentGeometry.boundingSphere
    ? state.currentGeometry.boundingSphere.radius
    : 30;
  const baseRadius = Math.max(0.08, modelRadius * 0.009);

  const isDark = state.theme === 'dark';
  const selectedMat = new THREE.MeshBasicMaterial({
    color: isDark ? 0xfacc15 : 0xf59e0b,
    depthTest: true,
  });
  const hoverMat = new THREE.MeshBasicMaterial({
    color: isDark ? 0xffffff : 0x0ea5e9,
    transparent: true,
    opacity: 0.9,
    depthTest: true,
  });

  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  const upVec = new THREE.Vector3(0, 1, 0);

  const addTubeForSeg = (seg, radius, material) => {
    const mesh = new THREE.Mesh(unitCyl, material);
    mesh.position.copy(seg.midpoint);
    const quat = new THREE.Quaternion().setFromUnitVectors(upVec, seg.tangent);
    mesh.quaternion.copy(quat);
    mesh.scale.set(radius, seg.length, radius);
    highlightTubesGroup.add(mesh);
  };

  for (const sId of state.selectedSegmentIds) {
    const seg = state.topology.segments[sId];
    if (seg) addTubeForSeg(seg, baseRadius * 1.25, selectedMat);
  }

  for (const sId of state.hoveredSegmentIds) {
    if (state.selectedSegmentIds.has(sId)) continue;
    const seg = state.topology.segments[sId];
    if (seg) addTubeForSeg(seg, baseRadius * 1.1, hoverMat);
  }
}

function updateLivePreviewMesh() {
  if (previewMesh) {
    scene.remove(previewMesh);
    previewMesh.geometry.dispose();
    previewMesh.material.dispose();
    previewMesh = null;
  }

  if (!state.showLivePreview || !state.topology || state.selectedSegmentIds.size === 0) {
    return;
  }

  try {
    const { previewGeometry } = buildOperationMeshes(
      state.topology,
      Array.from(state.selectedSegmentIds),
      getOperationParams()
    );

    const previewMat = new THREE.MeshStandardMaterial({
      color: state.opType === 'chamfer' ? 0xf59e0b : 0xa855f7,
      emissive: state.opType === 'chamfer' ? 0x78350f : 0x4c1d95,
      emissiveIntensity: 0.35,
      roughness: 0.3,
      metalness: 0.1,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.88,
      polygonOffset: true,
      polygonOffsetFactor: -1.5,
      polygonOffsetUnits: -2.0,
    });

    previewMesh = new THREE.Mesh(previewGeometry, previewMat);
    scene.add(previewMesh);
  } catch (err) {
    console.warn('Preview generation error:', err);
  }
}

function getOperationParams() {
  return {
    opType: state.opType,
    size1: state.size1,
    size2: state.size2,
    asymmetric: state.asymmetric,
    flipAsymmetric: state.flipAsymmetric,
    filletSegments: state.filletSegments,
    endpointMode: state.endpointMode,
  };
}

function pickEdgeAtPointer(clientX, clientY) {
  if (!state.topology || !modelMesh || !state.showEdges) return null;

  const rect = renderer.domElement.getBoundingClientRect();
  const mouseX = clientX - rect.left;
  const mouseY = clientY - rect.top;

  pointerNDC.x = (mouseX / rect.width) * 2 - 1;
  pointerNDC.y = -(mouseY / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointerNDC, camera);

  const hits = raycaster.intersectObject(modelMesh, false);
  const visibleSurfaceDist = hits.length > 0 ? hits[0].distance : Infinity;

  state.currentGeometry.computeBoundingSphere();
  const boundRadius = state.currentGeometry.boundingSphere
    ? state.currentGeometry.boundingSphere.radius
    : 30;
  const depthBias = Math.max(0.6, boundRadius * 0.035);

  const pA2D = new THREE.Vector3();
  const pB2D = new THREE.Vector3();
  const closest3D = new THREE.Vector3();

  let bestSeg = null;
  let bestPixelDist = 14;

  for (const seg of state.topology.segments) {
    if (seg.type === 'convex' && !state.filterConvex) continue;
    if (seg.type === 'concave' && !state.filterConcave) continue;

    pA2D.copy(seg.pA).project(camera);
    pB2D.copy(seg.pB).project(camera);

    if (pA2D.z > 1 && pB2D.z > 1) continue;

    const ax = (pA2D.x * 0.5 + 0.5) * rect.width;
    const ay = (-pA2D.y * 0.5 + 0.5) * rect.height;
    const bx = (pB2D.x * 0.5 + 0.5) * rect.width;
    const by = (-pB2D.y * 0.5 + 0.5) * rect.height;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 1e-4) {
      t = THREE.MathUtils.clamp(((mouseX - ax) * dx + (mouseY - ay) * dy) / lenSq, 0, 1);
    }

    const projX = ax + t * dx;
    const projY = ay + t * dy;
    const pixelDist = Math.hypot(mouseX - projX, mouseY - projY);

    if (pixelDist >= bestPixelDist) continue;

    closest3D.lerpVectors(seg.pA, seg.pB, t);
    const distToCam = camera.position.distanceTo(closest3D);

    if (distToCam <= visibleSurfaceDist + depthBias * 2.2) {
      bestPixelDist = pixelDist;
      bestSeg = seg;
    }
  }

  return bestSeg;
}

function fitCameraToModel() {
  if (!state.currentGeometry) return;
  state.currentGeometry.computeBoundingSphere();
  const sphere = state.currentGeometry.boundingSphere;
  if (!sphere) return;

  const r = Math.max(sphere.radius, 5);
  controls.target.copy(sphere.center);
  const dir = new THREE.Vector3(1.15, 0.85, 1.25).normalize();
  camera.position.copy(sphere.center).addScaledVector(dir, r * 2.55);
  camera.near = Math.max(0.05, r * 0.01);
  camera.far = Math.max(2000, r * 30);
  camera.updateProjectionMatrix();
  controls.update();
}

async function handleApplyOperation() {
  if (state.selectedSegmentIds.size === 0 || state.isApplying) return;

  state.isApplying = true;
  dom.btnApplyOp.disabled = true;
  dom.btnApplyText.textContent = 'Applying CSG Operation...';

  try {
    const selectedIds = Array.from(state.selectedSegmentIds);
    const params = getOperationParams();
    const newGeo = await applyEdgeOperationsCSG(state.topology, selectedIds, params);

    let conv = 0;
    let conc = 0;
    for (const id of selectedIds) {
      const s = state.topology.segments[id];
      if (s?.type === 'convex') conv++;
      else if (s?.type === 'concave') conc++;
    }

    const opName = state.opType === 'chamfer' ? 'Chamfer' : 'Fillet';
    const sizeDesc =
      state.opType === 'chamfer' && state.asymmetric
        ? `${state.size1}×${state.size2}mm`
        : `${state.size1}mm`;

    if (state.historyIndex < state.history.length - 1) {
      state.history.splice(state.historyIndex + 1);
    }

    state.history.push({
      geometry: newGeo.clone(),
      label: `${opName} (${sizeDesc}) on ${selectedIds.length} segs`,
      details: `${conv ? `${conv} convex` : ''}${conv && conc ? ', ' : ''}${conc ? `${conc} concave` : ''}`,
    });
    state.historyIndex = state.history.length - 1;

    applyGeometryState(newGeo, false);
    updateHistoryUI();
    showToast(`Applied ${opName} (${sizeDesc}) successfully!`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Operation failed: ${err.message}`, 'error');
  } finally {
    state.isApplying = false;
    updateSelectionUI();
  }
}

function updateSelectionUI() {
  const count = state.selectedSegmentIds.size;
  let convexCount = 0;
  let concaveCount = 0;

  if (state.topology) {
    for (const sId of state.selectedSegmentIds) {
      const seg = state.topology.segments[sId];
      if (!seg) continue;
      if (seg.type === 'convex') convexCount++;
      else concaveCount++;
    }
    dom.totalEdgesBadge.textContent = `${state.topology.smartGroups.length} edges (${state.topology.segments.length} segs)`;
  }

  dom.selectedCount.textContent = String(count);
  dom.selectedTypes.textContent = `${convexCount} / ${concaveCount}`;
  dom.btnClearSelection.disabled = count === 0;

  dom.btnApplyOp.disabled = count === 0 || state.isApplying;
  const opTitle = state.opType === 'chamfer' ? 'Chamfer' : 'Fillet';
  dom.btnApplyText.textContent =
    count === 0
      ? 'Select Edge(s) to Apply'
      : `Apply ${state.size1}mm ${opTitle} (${count} seg${count > 1 ? 's' : ''})`;

  if (count === 0 || !state.topology) {
    dom.selectedEdgesList.innerHTML = `
      <div class="empty-state">
        Click on any highlighted edge in the 3D view to select it.<br /><br />
        Blue = <strong>Convex</strong> (cuts corner)<br />
        Pink = <strong>Concave</strong> (fills corner)
      </div>
    `;
    return;
  }

  const groupBuckets = new Map();
  for (const sId of state.selectedSegmentIds) {
    const seg = state.topology.segments[sId];
    if (!seg) continue;
    const key = seg.smartGroupId >= 0 ? `G${seg.smartGroupId}` : `S${sId}`;
    if (!groupBuckets.has(key)) {
      groupBuckets.set(key, {
        key,
        type: seg.type,
        dihedralDeg: Math.round(seg.dihedralDeg),
        segIds: [],
        length: 0,
      });
    }
    const b = groupBuckets.get(key);
    b.segIds.push(sId);
    b.length += seg.length;
  }

  const itemsHtml = [];
  let idx = 1;
  for (const bucket of groupBuckets.values()) {
    itemsHtml.push(`
      <div class="edge-item">
        <div class="edge-item-left">
          <span class="edge-type-tag ${bucket.type}">${bucket.type}</span>
          <span>Edge #${idx} (${bucket.length.toFixed(1)}mm, ${bucket.dihedralDeg}°)</span>
        </div>
        <button type="button" class="edge-remove-btn" data-remove-segs="${bucket.segIds.join(',')}" title="Deselect this edge">✕</button>
      </div>
    `);
    idx++;
  }
  dom.selectedEdgesList.innerHTML = itemsHtml.join('');

  dom.selectedEdgesList.querySelectorAll('[data-remove-segs]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ids = btn.getAttribute('data-remove-segs').split(',').map(Number);
      for (const id of ids) state.selectedSegmentIds.delete(id);
      rebuildFeatureEdgeLines();
      rebuildHighlightTubes();
      updateLivePreviewMesh();
      updateSelectionUI();
    });
  });
}

function updateModelInfoUI() {
  if (!state.currentGeometry || !state.topology) return;
  state.currentGeometry.computeBoundingBox();
  const bb = state.currentGeometry.boundingBox;
  const size = new THREE.Vector3();
  bb.getSize(size);

  dom.infoDimensions.textContent = `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`;
  dom.infoTriangles.textContent = state.topology.faces.length.toLocaleString();
  dom.infoManifold.textContent = state.topology.isWatertight
    ? 'Watertight Manifold'
    : `Open (${state.topology.boundaryEdgeCount} boundary)`;
  dom.infoManifold.style.color = state.topology.isWatertight ? '#10b981' : '#d97706';
}

function updateHistoryUI() {
  dom.btnUndo.disabled = state.historyIndex <= 0;
  dom.btnRedo.disabled = state.historyIndex >= state.history.length - 1;

  const appliedSteps = state.history.slice(1, state.historyIndex + 1);
  dom.opHistoryCount.textContent = `${appliedSteps.length} step${appliedSteps.length === 1 ? '' : 's'}`;

  if (appliedSteps.length === 0) {
    dom.opHistoryList.innerHTML = `
      <div class="empty-state">
        No operations applied yet. Select edges and click <strong>Apply</strong> to modify the mesh.
      </div>
    `;
    return;
  }

  dom.opHistoryList.innerHTML = appliedSteps
    .map(
      (step, i) => `
      <div class="history-item">
        <div>
          <strong>${i + 1}. ${step.label}</strong>
          <div style="font-size:10.5px;color:var(--text-muted)">${step.details || ''}</div>
        </div>
      </div>
    `
    )
    .reverse()
    .join('');
}

async function loadSample(sampleId) {
  try {
    const { name, geometry } = await createSampleModel(sampleId);
    setBaseModelGeometry(geometry, name);
    showToast(`Loaded sample: ${name}`, 'info');
  } catch (err) {
    console.error(err);
    showToast(`Failed to load sample: ${err.message}`, 'error');
  }
}

function loadUserSTLFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const loader = new STLLoader();
      const geometry = loader.parse(e.target.result);
      if (!geometry || !geometry.getAttribute('position') || geometry.getAttribute('position').count === 0) {
        throw new Error('STL file contains no valid triangles.');
      }
      setBaseModelGeometry(geometry, file.name);
      showToast(`Loaded ${file.name} successfully!`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`Could not parse STL file: ${err.message}`, 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportCurrentSTL() {
  if (!modelMesh) return;
  try {
    const exporter = new STLExporter();
    const result = exporter.parse(modelMesh, { binary: true });
    const blob = new Blob([result], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    const baseName = state.modelName.replace(/\.stl$/i, '');
    const outName = `${baseName}_edgecraft.stl`;

    const a = document.createElement('a');
    a.href = url;
    a.download = outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`Exported ${outName}`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Export failed: ${err.message}`, 'error');
  }
}

function bindUIEvents() {
  if (dom.btnThemeToggle) {
    dom.btnThemeToggle.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
  }

  const closeLibrariesModal = () => dom.librariesModal?.classList.add('hidden');
  dom.btnOpenLibraries?.addEventListener('click', () => {
    dom.librariesModal?.classList.remove('hidden');
  });
  dom.btnCloseLibraries?.addEventListener('click', closeLibrariesModal);
  dom.btnDoneLibraries?.addEventListener('click', closeLibrariesModal);
  dom.librariesModal?.addEventListener('click', (e) => {
    if (e.target === dom.librariesModal) closeLibrariesModal();
  });

  dom.fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      loadUserSTLFile(file);
      dom.fileInput.value = '';
    }
  });

  dom.sampleSelect.addEventListener('change', (e) => {
    if (e.target.value) {
      loadSample(e.target.value);
    }
  });

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.dropOverlay.classList.remove('hidden');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dom.dropOverlay.classList.add('hidden');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.dropOverlay.classList.add('hidden');
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      loadUserSTLFile(file);
    }
  });

  dom.btnUndo.addEventListener('click', () => {
    if (state.historyIndex > 0) {
      state.historyIndex--;
      applyGeometryState(state.history[state.historyIndex].geometry.clone(), false);
      updateHistoryUI();
    }
  });

  dom.btnRedo.addEventListener('click', () => {
    if (state.historyIndex < state.history.length - 1) {
      state.historyIndex++;
      applyGeometryState(state.history[state.historyIndex].geometry.clone(), false);
      updateHistoryUI();
    }
  });

  dom.btnResetModel.addEventListener('click', () => {
    if (!state.originalGeometry) return;
    setBaseModelGeometry(state.originalGeometry.clone(), state.modelName);
    showToast('Reset model to original geometry.', 'info');
  });

  dom.btnExportStl.addEventListener('click', exportCurrentSTL);

  const modeHints = {
    smart: 'Automatically heals split STL edges along flat faces and smooth curves.',
    collinear: 'Selects strictly straight collinear edge segments.',
    loop: 'Selects entire connected edge rings/perimeters of the same type.',
    segment: 'Selects individual raw STL triangle segments for fine control.',
  };

  dom.segModeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      dom.segModeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.selectionMode = btn.getAttribute('data-select-mode');
      dom.selectionModeHint.textContent = modeHints[state.selectionMode] || '';
    });
  });

  dom.creaseSlider.addEventListener('input', (e) => {
    state.creaseAngleDeg = Number(e.target.value);
    dom.creaseVal.textContent = `${state.creaseAngleDeg}°`;
    rebuildTopology();
  });

  dom.filterConvex.addEventListener('change', (e) => {
    state.filterConvex = e.target.checked;
    rebuildFeatureEdgeLines();
  });

  dom.filterConcave.addEventListener('change', (e) => {
    state.filterConcave = e.target.checked;
    rebuildFeatureEdgeLines();
  });

  dom.btnClearSelection.addEventListener('click', () => {
    state.selectedSegmentIds.clear();
    rebuildFeatureEdgeLines();
    rebuildHighlightTubes();
    updateLivePreviewMesh();
    updateSelectionUI();
  });

  dom.btnInvertSelection.addEventListener('click', () => {
    if (!state.topology) return;
    const nextSet = new Set();
    for (const seg of state.topology.segments) {
      if (seg.type === 'convex' && !state.filterConvex) continue;
      if (seg.type === 'concave' && !state.filterConcave) continue;
      if (!state.selectedSegmentIds.has(seg.id)) {
        nextSet.add(seg.id);
      }
    }
    state.selectedSegmentIds = nextSet;
    rebuildFeatureEdgeLines();
    rebuildHighlightTubes();
    updateLivePreviewMesh();
    updateSelectionUI();
  });

  dom.btnFitView.addEventListener('click', fitCameraToModel);

  dom.btnToggleWireframe.addEventListener('click', () => {
    state.showWireframe = !state.showWireframe;
    dom.btnToggleWireframe.classList.toggle('active', state.showWireframe);
    if (wireframeMesh) wireframeMesh.visible = state.showWireframe;
  });

  dom.btnTogglePreview.addEventListener('click', () => {
    state.showLivePreview = !state.showLivePreview;
    dom.btnTogglePreview.classList.toggle('active', state.showLivePreview);
    updateLivePreviewMesh();
  });

  dom.btnToggleEdges.addEventListener('click', () => {
    state.showEdges = !state.showEdges;
    dom.btnToggleEdges.classList.toggle('active', state.showEdges);
    if (featureLinesMesh) featureLinesMesh.visible = state.showEdges;
    rebuildHighlightTubes();
  });

  dom.opCards.forEach((card) => {
    card.addEventListener('click', () => {
      dom.opCards.forEach((c) => c.classList.remove('active'));
      card.classList.add('active');
      state.opType = card.getAttribute('data-op-type');

      const isChamfer = state.opType === 'chamfer';
      dom.sizeLabel.textContent = isChamfer ? 'Chamfer Distance (mm)' : 'Fillet Setback / Radius (mm)';
      dom.chamferSymmetryGroup.classList.toggle('hidden', !isChamfer);
      dom.filletSegmentsGroup.classList.toggle('hidden', isChamfer);

      updateLivePreviewMesh();
      updateSelectionUI();
    });
  });

  const syncSize1 = (val) => {
    const num = Math.max(0.05, Math.min(100, Number(val) || 1.0));
    state.size1 = num;
    dom.sizeInput.value = num;
    dom.sizeSlider.value = Math.min(15, num);
    dom.presetBtns.forEach((btn) => {
      btn.classList.toggle('active', Math.abs(Number(btn.dataset.size) - num) < 1e-3);
    });
    updateLivePreviewMesh();
    updateSelectionUI();
  };

  dom.sizeSlider.addEventListener('input', (e) => syncSize1(e.target.value));
  dom.sizeInput.addEventListener('input', (e) => syncSize1(e.target.value));
  dom.presetBtns.forEach((btn) => {
    btn.addEventListener('click', () => syncSize1(btn.dataset.size));
  });

  dom.asymmetricToggle.addEventListener('change', (e) => {
    state.asymmetric = e.target.checked;
    dom.asymmetricControls.classList.toggle('hidden', !state.asymmetric);
    updateLivePreviewMesh();
  });

  const syncSize2 = (val) => {
    const num = Math.max(0.05, Math.min(100, Number(val) || 1.0));
    state.size2 = num;
    dom.size2Input.value = num;
    dom.size2Slider.value = Math.min(15, num);
    updateLivePreviewMesh();
  };

  dom.size2Slider.addEventListener('input', (e) => syncSize2(e.target.value));
  dom.size2Input.addEventListener('input', (e) => syncSize2(e.target.value));

  dom.btnFlipAsymmetric.addEventListener('click', () => {
    state.flipAsymmetric = !state.flipAsymmetric;
    updateLivePreviewMesh();
  });

  dom.filletSegmentsSlider.addEventListener('input', (e) => {
    state.filletSegments = Number(e.target.value);
    dom.filletSegmentsVal.textContent = String(state.filletSegments);
    updateLivePreviewMesh();
  });

  dom.endpointModeSelect.addEventListener('change', (e) => {
    state.endpointMode = e.target.value;
    updateLivePreviewMesh();
  });

  dom.btnApplyOp.addEventListener('click', handleApplyOperation);

  const canvas = renderer.domElement;

  canvas.addEventListener('pointerdown', (e) => {
    pointerDownPos = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons !== 0) {
      dom.edgeTooltip.classList.add('hidden');
      return;
    }

    const hitSeg = pickEdgeAtPointer(e.clientX, e.clientY);
    const hitId = hitSeg ? hitSeg.id : null;

    if (hitId !== state.hoveredLeadSegId) {
      state.hoveredLeadSegId = hitId;
      state.hoveredSegmentIds.clear();

      if (hitSeg) {
        const groupIds = getGroupSegmentIds(state.topology, hitSeg.id, state.selectionMode);
        for (const id of groupIds) state.hoveredSegmentIds.add(id);
        canvas.style.cursor = 'pointer';
      } else {
        canvas.style.cursor = 'grab';
      }

      rebuildFeatureEdgeLines();
      rebuildHighlightTubes();
    }

    if (hitSeg) {
      const rect = dom.viewportWrapper.getBoundingClientRect();
      dom.edgeTooltip.style.left = `${e.clientX - rect.left}px`;
      dom.edgeTooltip.style.top = `${e.clientY - rect.top}px`;
      const typeLabel = hitSeg.type === 'convex' ? 'Convex (Outside)' : 'Concave (Inside)';
      dom.edgeTooltip.innerHTML = `<strong>${typeLabel}</strong> • ${Math.round(hitSeg.dihedralDeg)}° crease`;
      dom.edgeTooltip.classList.remove('hidden');
    } else {
      dom.edgeTooltip.classList.add('hidden');
    }
  });

  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    if (moveDist > 5) return;

    const hitSeg = pickEdgeAtPointer(e.clientX, e.clientY);
    if (!hitSeg) return;

    const groupIds = getGroupSegmentIds(state.topology, hitSeg.id, state.selectionMode);
    const allAlreadySelected = groupIds.every((id) => state.selectedSegmentIds.has(id));

    if (allAlreadySelected) {
      for (const id of groupIds) state.selectedSegmentIds.delete(id);
    } else {
      for (const id of groupIds) state.selectedSegmentIds.add(id);
    }

    rebuildFeatureEdgeLines();
    rebuildHighlightTubes();
    updateLivePreviewMesh();
    updateSelectionUI();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

    if (e.key === 'Escape') {
      if (dom.librariesModal && !dom.librariesModal.classList.contains('hidden')) {
        closeLibrariesModal();
        return;
      }
      state.selectedSegmentIds.clear();
      rebuildFeatureEdgeLines();
      rebuildHighlightTubes();
      updateLivePreviewMesh();
      updateSelectionUI();
    } else if (e.key === 'Enter') {
      if (state.selectedSegmentIds.size > 0 && !state.isApplying) {
        handleApplyOperation();
      }
    } else if (e.key.toLowerCase() === 'f') {
      fitCameraToModel();
    } else if (e.key.toLowerCase() === 'w') {
      dom.btnToggleWireframe.click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      dom.btnUndo.click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      dom.btnRedo.click();
    }
  });
}

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  dom.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.25s ease';
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

init();
