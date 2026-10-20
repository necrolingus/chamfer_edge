import * as THREE from 'three';

let manifoldModule = null;
let manifoldInitPromise = null;

/**
 * Initializes the manifold-3d WASM boolean engine.
 */
export async function initCSGEngine() {
  if (manifoldModule) return manifoldModule;
  if (manifoldInitPromise) return manifoldInitPromise;

  manifoldInitPromise = (async () => {
    try {
      const modFactory = (await import('manifold-3d')).default;
      const wasm = await modFactory({
        locateFile: () => 'https://cdn.jsdelivr.net/npm/manifold-3d@3.0.0/manifold.wasm',
      });
      if (typeof wasm.setup === 'function') {
        wasm.setup();
      }
      manifoldModule = wasm;
      return wasm;
    } catch (err) {
      console.warn('Manifold WASM failed to load, using fallback mesh engine:', err);
      return null;
    }
  })();

  return manifoldInitPromise;
}

/**
 * Builds the 2D profile points (in 3D world space) for a single cross-section frame.
 * Returns:
 * - surfacePts: points along the visible chamfer/fillet surface from q1 (on face 1) to q2 (on face 2)
 * - ringPts: full closed polygon ring for solid extrusion (includes outer clearance for convex or inner embed for concave)
 */
function buildCrossSectionFrame(origin, n1, n2, u1, u2, miterScale, params, segType) {
  const {
    opType = 'chamfer',
    size1 = 2.0,
    size2 = 2.0,
    asymmetric = false,
    flipAsymmetric = false,
    filletSegments = 12,
  } = params;

  let d1 = size1;
  let d2 = asymmetric ? size2 : size1;
  if (asymmetric && flipAsymmetric) {
    const tmp = d1;
    d1 = d2;
    d2 = tmp;
  }

  d1 *= miterScale;
  d2 *= miterScale;

  // Touch points on face 1 and face 2
  const q1 = origin.clone().addScaledVector(u1, d1);
  const q2 = origin.clone().addScaledVector(u2, d2);

  const surfacePts = [];
  if (opType === 'chamfer') {
    surfacePts.push(q1.clone(), q2.clone());
  } else {
    // Exact Rational Quadratic Bezier circular/elliptical fillet arc from q1 to q2 with control point `origin`
    const cosAlpha = THREE.MathUtils.clamp(u1.dot(u2), -0.99, 0.99);
    const alpha = Math.acos(cosAlpha);
    const weight = Math.max(0.15, Math.sin(alpha * 0.5));
    const steps = Math.max(3, Math.min(32, Math.round(filletSegments)));

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const omt = 1 - t;
      const b0 = omt * omt;
      const b1 = 2 * weight * t * omt;
      const b2 = t * t;
      const denom = b0 + b1 + b2;

      const pt = new THREE.Vector3()
        .addScaledVector(q1, b0 / denom)
        .addScaledVector(origin, b1 / denom)
        .addScaledVector(q2, b2 / denom);
      surfacePts.push(pt);
    }
  }

  const maxD = Math.max(d1, d2);
  const ringPts = [...surfacePts];

  if (segType === 'convex') {
    // Extend cutter volume outward into empty space past face 1, face 2, and the corner apex
    const outMargin = Math.max(0.4, maxD * 0.85);
    const o2 = q2
      .clone()
      .addScaledVector(n2, outMargin)
      .addScaledVector(u2, maxD * 0.08);
    const nSum = new THREE.Vector3().addVectors(n1, n2);
    if (nSum.lengthSq() < 1e-4) {
      nSum.copy(n1);
    } else {
      nSum.normalize();
    }
    const oMid = origin.clone().addScaledVector(nSum, outMargin * 1.45);
    const o1 = q1
      .clone()
      .addScaledVector(n1, outMargin)
      .addScaledVector(u1, maxD * 0.08);

    ringPts.push(o2, oMid, o1);
  } else {
    // Concave edge: embed back of filler volume slightly into the solid interior (-n1, -n2)
    // so the boolean union is 100% watertight without coplanar face slivers.
    const embed = Math.min(Math.max(0.08, maxD * 0.28), maxD * 0.6);
    const b2 = q2
      .clone()
      .addScaledVector(n2, -embed)
      .addScaledVector(u2, -maxD * 0.04);
    const nSum = new THREE.Vector3().addVectors(n1, n2);
    if (nSum.lengthSq() < 1e-4) {
      nSum.copy(n1);
    } else {
      nSum.normalize();
    }
    const bMid = origin.clone().addScaledVector(nSum, -embed * 1.35);
    const b1 = q1
      .clone()
      .addScaledVector(n1, -embed)
      .addScaledVector(u1, -maxD * 0.04);

    ringPts.push(b2, bMid, b1);
  }

  return { surfacePts, ringPts };
}

/**
 * Groups selected segments into ordered continuous paths (or closed loops)
 * where adjacent segments share a vertex and turn smoothly (< 40 deg).
 */
function buildSelectedSmoothPaths(topology, selectedIds) {
  const selectedSet = new Set(selectedIds);
  const visited = new Set();
  const paths = [];

  // Map vertex -> selected incident segment IDs
  const vertMap = new Map();
  for (const sId of selectedSet) {
    const seg = topology.segments[sId];
    if (!seg) continue;
    if (!vertMap.has(seg.vaIdx)) vertMap.set(seg.vaIdx, []);
    if (!vertMap.has(seg.vbIdx)) vertMap.set(seg.vbIdx, []);
    vertMap.get(seg.vaIdx).push(sId);
    vertMap.get(seg.vbIdx).push(sId);
  }

  const maxTurnCos = Math.cos(THREE.MathUtils.degToRad(40));

  const getContinuation = (currSegId, vIdx) => {
    const currSeg = topology.segments[currSegId];
    const candidates = vertMap.get(vIdx) || [];
    const dirCurr =
      currSeg.vaIdx === vIdx ? currSeg.tangent.clone() : currSeg.tangent.clone().negate();

    let bestId = null;
    let bestAlign = -1;
    for (const cId of candidates) {
      if (cId === currSegId || visited.has(cId)) continue;
      const cand = topology.segments[cId];
      if (cand.type !== currSeg.type) continue;
      const dirCand =
        cand.vaIdx === vIdx ? cand.tangent.clone() : cand.tangent.clone().negate();
      const align = -dirCurr.dot(dirCand); // 1.0 when straight
      if (align >= maxTurnCos && align > bestAlign) {
        bestAlign = align;
        bestId = cId;
      }
    }
    return bestId;
  };

  for (const seedId of selectedSet) {
    if (visited.has(seedId)) continue;
    const seedSeg = topology.segments[seedId];
    if (!seedSeg) continue;
    visited.add(seedId);

    // Ordered list of directed segments: { seg, fromVert, toVert, reversed }
    const chain = [
      {
        seg: seedSeg,
        fromVert: seedSeg.vaIdx,
        toVert: seedSeg.vbIdx,
        reversed: false,
      },
    ];

    // Grow forward from toVert
    let currSegId = seedId;
    let currVert = seedSeg.vbIdx;
    while (true) {
      const nextId = getContinuation(currSegId, currVert);
      if (nextId === null) break;
      visited.add(nextId);
      const nextSeg = topology.segments[nextId];
      const reversed = nextSeg.vaIdx !== currVert;
      const nextTo = reversed ? nextSeg.vaIdx : nextSeg.vbIdx;
      chain.push({
        seg: nextSeg,
        fromVert: currVert,
        toVert: nextTo,
        reversed,
      });
      currVert = nextTo;
      currSegId = nextId;
    }

    // Grow backward from chain[0].fromVert
    currSegId = seedId;
    currVert = seedSeg.vaIdx;
    while (true) {
      const prevId = getContinuation(currSegId, currVert);
      if (prevId === null) break;
      visited.add(prevId);
      const prevSeg = topology.segments[prevId];
      // We want prevSeg to end at currVert
      const reversed = prevSeg.vbIdx !== currVert;
      const prevFrom = reversed ? prevSeg.vbIdx : prevSeg.vaIdx;
      chain.unshift({
        seg: prevSeg,
        fromVert: prevFrom,
        toVert: currVert,
        reversed,
      });
      currVert = prevFrom;
      currSegId = prevId;
    }

    // Check if the chain forms a closed loop whose ends also meet smoothly
    const first = chain[0];
    const last = chain[chain.length - 1];
    let isClosed = false;
    if (chain.length >= 3 && first.fromVert === last.toVert) {
      const dFirst = first.reversed
        ? first.seg.tangent.clone().negate()
        : first.seg.tangent.clone();
      const dLast = last.reversed
        ? last.seg.tangent.clone().negate()
        : last.seg.tangent.clone();
      if (dFirst.dot(dLast) >= maxTurnCos) {
        isClosed = true;
      }
    }

    paths.push({
      type: seedSeg.type,
      items: chain,
      isClosed,
    });
  }

  return paths;
}

/**
 * Checks whether extending past an open endpoint vertex `vIdx` in direction `outDir`
 * would collide with an unselected concave wall face incident to `vIdx`.
 */
function computeEndpointExtension(topology, vIdx, outDir, seg, maxD, endpointMode) {
  if (endpointMode === 'flush') {
    return 0;
  }
  if (endpointMode === 'extend') {
    return seg.type === 'convex' ? Math.max(0.15, maxD * 0.35) : 0.02;
  }

  // 'smart' mode:
  // Check all faces incident to vIdx via topology segments or check if another feature edge meets here
  const incidentSegIds = topology.vertToSegments.get(vIdx) || [];
  for (const otherId of incidentSegIds) {
    if (otherId === seg.id) continue;
    const other = topology.segments[otherId];
    // If a concave feature edge meets at this vertex, there is an interior wall right at vIdx!
    if (other.type === 'concave') {
      return 0.002;
    }
  }

  if (seg.type === 'convex') {
    // Small clean extension so exterior faces are sliced completely through without leaving a sliver
    return 0.06;
  }
  return 0.01;
}

/**
 * Generates both:
 * 1. `previewGeometry`: A THREE.BufferGeometry showing the exact bevel/fillet surface strip in the 3D viewport
 * 2. `convexSolids` & `concaveSolids`: Watertight indexed triangle meshes ready for Manifold CSG subtraction/union
 */
export function buildOperationMeshes(topology, selectedIds, params) {
  const paths = buildSelectedSmoothPaths(topology, selectedIds);

  const previewPositions = [];
  const previewNormals = [];
  const convexSolids = [];
  const concaveSolids = [];

  const maxD = Math.max(params.size1 || 2, params.asymmetric ? params.size2 || 2 : params.size1 || 2);

  for (const path of paths) {
    const { items, isClosed, type } = path;
    const numSegs = items.length;

    // Oriented frame per segment in the chain
    const segFrames = items.map((item) => {
      const { seg, reversed } = item;
      const tangent = reversed ? seg.tangent.clone().negate() : seg.tangent.clone();
      // Keep side 1 and side 2 consistent along the path
      const n1 = reversed ? seg.n2.clone() : seg.n1.clone();
      const n2 = reversed ? seg.n1.clone() : seg.n2.clone();
      const u1 = reversed ? seg.u2.clone() : seg.u1.clone();
      const u2 = reversed ? seg.u1.clone() : seg.u2.clone();
      return { tangent, n1, n2, u1, u2, seg };
    });

    // Ensure consistent side pairing across consecutive segments (so u1/n1 don't swap with u2/n2)
    for (let i = 1; i < numSegs; i++) {
      const prev = segFrames[i - 1];
      const curr = segFrames[i];
      const directScore =
        prev.u1.dot(curr.u1) + prev.u2.dot(curr.u2) + prev.n1.dot(curr.n1) + prev.n2.dot(curr.n2);
      const swappedScore =
        prev.u1.dot(curr.u2) + prev.u2.dot(curr.u1) + prev.n1.dot(curr.n2) + prev.n2.dot(curr.n1);
      if (directScore < swappedScore) {
        const tmpN = curr.n1;
        curr.n1 = curr.n2;
        curr.n2 = tmpN;
        const tmpU = curr.u1;
        curr.u1 = curr.u2;
        curr.u2 = tmpU;
      }
    }

    // Build vertex stations along the path (numSegs + 1 stations, or numSegs if closed)
    const stationCount = isClosed ? numSegs : numSegs + 1;
    const rings = [];
    const surfaceStrips = [];

    for (let k = 0; k < stationCount; k++) {
      let vIdx;
      let origin;
      let n1, n2, u1, u2;
      let miterScale = 1.0;

      if (isClosed) {
        const prevF = segFrames[(k - 1 + numSegs) % numSegs];
        const currF = segFrames[k];
        vIdx = items[k].fromVert;
        origin = topology.vertices[vIdx].clone();

        n1 = new THREE.Vector3().addVectors(prevF.n1, currF.n1).normalize();
        n2 = new THREE.Vector3().addVectors(prevF.n2, currF.n2).normalize();
        u1 = new THREE.Vector3().addVectors(prevF.u1, currF.u1);
        u2 = new THREE.Vector3().addVectors(prevF.u2, currF.u2);
        const len1 = u1.length();
        const len2 = u2.length();
        if (len1 > 1e-4) u1.divideScalar(len1);
        if (len2 > 1e-4) u2.divideScalar(len2);

        const cosHalfTurn = Math.max(0.65, 0.5 * (len1 + len2) * 0.5);
        miterScale = Math.min(1.45, 1 / cosHalfTurn);
      } else if (k === 0) {
        const f = segFrames[0];
        vIdx = items[0].fromVert;
        const outDir = f.tangent.clone().negate();
        const ext = computeEndpointExtension(
          topology,
          vIdx,
          outDir,
          f.seg,
          maxD,
          params.endpointMode || 'smart'
        );
        origin = topology.vertices[vIdx].clone().addScaledVector(outDir, ext);
        n1 = f.n1;
        n2 = f.n2;
        u1 = f.u1;
        u2 = f.u2;
      } else if (k === numSegs) {
        const f = segFrames[numSegs - 1];
        vIdx = items[numSegs - 1].toVert;
        const outDir = f.tangent.clone();
        const ext = computeEndpointExtension(
          topology,
          vIdx,
          outDir,
          f.seg,
          maxD,
          params.endpointMode || 'smart'
        );
        origin = topology.vertices[vIdx].clone().addScaledVector(outDir, ext);
        n1 = f.n1;
        n2 = f.n2;
        u1 = f.u1;
        u2 = f.u2;
      } else {
        const prevF = segFrames[k - 1];
        const currF = segFrames[k];
        vIdx = items[k].fromVert;
        origin = topology.vertices[vIdx].clone();

        n1 = new THREE.Vector3().addVectors(prevF.n1, currF.n1).normalize();
        n2 = new THREE.Vector3().addVectors(prevF.n2, currF.n2).normalize();
        u1 = new THREE.Vector3().addVectors(prevF.u1, currF.u1);
        u2 = new THREE.Vector3().addVectors(prevF.u2, currF.u2);
        const len1 = u1.length();
        const len2 = u2.length();
        if (len1 > 1e-4) u1.divideScalar(len1);
        if (len2 > 1e-4) u2.divideScalar(len2);

        const cosHalf = Math.max(0.65, Math.sqrt(0.5 * (1 + prevF.tangent.dot(currF.tangent))));
        miterScale = Math.min(1.45, 1 / cosHalf);
      }

      const frame = buildCrossSectionFrame(origin, n1, n2, u1, u2, miterScale, params, type);
      rings.push(frame.ringPts);
      surfaceStrips.push(frame.surfacePts);
    }

    // 1. Add visible bevel/fillet surface quads to preview geometry
    for (let s = 0; s < numSegs; s++) {
      const stripA = surfaceStrips[s];
      const stripB = surfaceStrips[(s + 1) % stationCount];
      for (let j = 0; j < stripA.length - 1; j++) {
        const p00 = stripA[j];
        const p01 = stripA[j + 1];
        const p10 = stripB[j];
        const p11 = stripB[j + 1];

        addTriangleToPreview(previewPositions, previewNormals, p00, p10, p11);
        addTriangleToPreview(previewPositions, previewNormals, p00, p11, p01);
      }
    }

    // 2. Build watertight solid mesh for this swept path
    const solid = buildWatertightSweepSolid(rings, isClosed);
    if (solid) {
      if (type === 'convex') {
        convexSolids.push(solid);
      } else {
        concaveSolids.push(solid);
      }
    }
  }

  const previewGeometry = new THREE.BufferGeometry();
  previewGeometry.setAttribute('position', new THREE.Float32BufferAttribute(previewPositions, 3));
  previewGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(previewNormals, 3));

  return {
    previewGeometry,
    convexSolids,
    concaveSolids,
  };
}

function addTriangleToPreview(positions, normals, a, b, c) {
  const ab = new THREE.Vector3().subVectors(b, a);
  const ac = new THREE.Vector3().subVectors(c, a);
  const n = new THREE.Vector3().crossVectors(ab, ac).normalize();

  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  normals.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
}

/**
 * Stitches a sequence of polygon rings into a closed, consistently-oriented watertight triangle mesh.
 * Automatically verifies positive signed volume so outward normals point outward.
 */
function buildWatertightSweepSolid(rings, isClosed) {
  if (!rings || rings.length < 2) return null;
  const ringSize = rings[0].length;
  const numRings = rings.length;

  const verts = [];
  for (let r = 0; r < numRings; r++) {
    for (let j = 0; j < ringSize; j++) {
      const p = rings[r][j];
      verts.push(p.x, p.y, p.z);
    }
  }

  const tris = [];
  const segCount = isClosed ? numRings : numRings - 1;

  for (let r = 0; r < segCount; r++) {
    const nextR = (r + 1) % numRings;
    const baseA = r * ringSize;
    const baseB = nextR * ringSize;

    for (let j = 0; j < ringSize; j++) {
      const nextJ = (j + 1) % ringSize;
      const i00 = baseA + j;
      const i01 = baseA + nextJ;
      const i10 = baseB + j;
      const i11 = baseB + nextJ;

      tris.push(i00, i10, i11);
      tris.push(i00, i11, i01);
    }
  }

  if (!isClosed) {
    // Use `oMid` / `bMid` (index ringSize - 2) as the star-convex fan pivot
    // so curved fillet arcs never self-intersect on the endcaps!
    const pivot = ringSize - 2;

    // Start cap (ring 0): side walls have boundary half-edges (nextJ -> j),
    // so start cap must have boundary half-edges (j -> nextJ).
    for (let k = 1; k <= ringSize - 2; k++) {
      const v1 = (pivot + k) % ringSize;
      const v2 = (pivot + k + 1) % ringSize;
      tris.push(pivot, v1, v2);
    }

    // End cap (ring numRings - 1): side walls have boundary half-edges (j -> nextJ),
    // so end cap must have boundary half-edges (nextJ -> j).
    const baseEnd = (numRings - 1) * ringSize;
    for (let k = 1; k <= ringSize - 2; k++) {
      const v1 = (pivot + k) % ringSize;
      const v2 = (pivot + k + 1) % ringSize;
      tris.push(baseEnd + pivot, baseEnd + v2, baseEnd + v1);
    }
  }

  // Ensure positive signed volume (outward-pointing triangle winding)
  let signedVol6 = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const i0 = tris[i] * 3;
    const i1 = tris[i + 1] * 3;
    const i2 = tris[i + 2] * 3;
    const ax = verts[i0], ay = verts[i0 + 1], az = verts[i0 + 2];
    const bx = verts[i1], by = verts[i1 + 1], bz = verts[i1 + 2];
    const cx = verts[i2], cy = verts[i2 + 1], cz = verts[i2 + 2];
    signedVol6 += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }

  if (signedVol6 < 0) {
    for (let i = 0; i < tris.length; i += 3) {
      const tmp = tris[i + 1];
      tris[i + 1] = tris[i + 2];
      tris[i + 2] = tmp;
    }
  }

  return {
    vertProperties: new Float32Array(verts),
    triVerts: new Uint32Array(tris),
  };
}

/**
 * Converts our analyzed welded topology into a Manifold-compatible indexed mesh.
 */
function topologyToIndexedData(topology) {
  const numVerts = topology.vertices.length;
  const vertProperties = new Float32Array(numVerts * 3);
  for (let i = 0; i < numVerts; i++) {
    const v = topology.vertices[i];
    vertProperties[i * 3] = v.x;
    vertProperties[i * 3 + 1] = v.y;
    vertProperties[i * 3 + 2] = v.z;
  }

  const numFaces = topology.faces.length;
  const triVerts = new Uint32Array(numFaces * 3);
  for (let i = 0; i < numFaces; i++) {
    const f = topology.faces[i];
    triVerts[i * 3] = f.a;
    triVerts[i * 3 + 1] = f.b;
    triVerts[i * 3 + 2] = f.c;
  }

  return { vertProperties, triVerts };
}

/**
 * Executes the boolean CSG operation (Subtract for Convex edges, Union for Concave edges)
 * using Manifold-3D WASM and returns a clean THREE.BufferGeometry with flat normals.
 */
export async function applyEdgeOperationsCSG(topology, selectedIds, params) {
  const { convexSolids, concaveSolids } = buildOperationMeshes(topology, selectedIds, params);
  if (convexSolids.length === 0 && concaveSolids.length === 0) {
    throw new Error('No valid edge operations to apply.');
  }

  const wasm = await initCSGEngine();
  if (!wasm) {
    throw new Error('CSG Boolean Engine is still loading or unavailable.');
  }

  const { Manifold, Mesh } = wasm;
  const baseData = topologyToIndexedData(topology);

  const toDelete = [];
  try {
    const baseMesh = new Mesh({
      numProp: 3,
      vertProperties: baseData.vertProperties,
      triVerts: baseData.triVerts,
    });
    let currentManifold = new Manifold(baseMesh);
    toDelete.push(currentManifold);

    // 1. Subtract all convex edge cutters
    for (const cutter of convexSolids) {
      const mMesh = new Mesh({
        numProp: 3,
        vertProperties: cutter.vertProperties,
        triVerts: cutter.triVerts,
      });
      const cutterManifold = new Manifold(mMesh);
      toDelete.push(cutterManifold);

      const nextManifold = currentManifold.subtract(cutterManifold);
      toDelete.push(nextManifold);
      currentManifold = nextManifold;
    }

    // 2. Union all concave edge fillers
    for (const filler of concaveSolids) {
      const mMesh = new Mesh({
        numProp: 3,
        vertProperties: filler.vertProperties,
        triVerts: filler.triVerts,
      });
      const fillerManifold = new Manifold(mMesh);
      toDelete.push(fillerManifold);

      const nextManifold = currentManifold.add(fillerManifold);
      toDelete.push(nextManifold);
      currentManifold = nextManifold;
    }

    const outMesh = currentManifold.getMesh();
    const outVerts = outMesh.vertProperties;
    const outTris = outMesh.triVerts;
    const numProp = outMesh.numProp || 3;

    // Build unindexed THREE.BufferGeometry with crisp per-triangle normals (standard for STL)
    const triCount = outTris.length / 3;
    const positions = new Float32Array(triCount * 9);
    const normals = new Float32Array(triCount * 9);

    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();
    const vC = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const norm = new THREE.Vector3();

    for (let t = 0; t < triCount; t++) {
      const i0 = outTris[t * 3] * numProp;
      const i1 = outTris[t * 3 + 1] * numProp;
      const i2 = outTris[t * 3 + 2] * numProp;

      vA.set(outVerts[i0], outVerts[i0 + 1], outVerts[i0 + 2]);
      vB.set(outVerts[i1], outVerts[i1 + 1], outVerts[i1 + 2]);
      vC.set(outVerts[i2], outVerts[i2 + 1], outVerts[i2 + 2]);

      ab.subVectors(vB, vA);
      ac.subVectors(vC, vA);
      norm.crossVectors(ab, ac).normalize();

      const base = t * 9;
      positions[base] = vA.x;
      positions[base + 1] = vA.y;
      positions[base + 2] = vA.z;
      positions[base + 3] = vB.x;
      positions[base + 4] = vB.y;
      positions[base + 5] = vB.z;
      positions[base + 6] = vC.x;
      positions[base + 7] = vC.y;
      positions[base + 8] = vC.z;

      normals[base] = norm.x;
      normals[base + 1] = norm.y;
      normals[base + 2] = norm.z;
      normals[base + 3] = norm.x;
      normals[base + 4] = norm.y;
      normals[base + 5] = norm.z;
      normals[base + 6] = norm.x;
      normals[base + 7] = norm.y;
      normals[base + 8] = norm.z;
    }

    const resultGeo = new THREE.BufferGeometry();
    resultGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    resultGeo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    return resultGeo;
  } finally {
    for (const m of toDelete) {
      try {
        if (m && typeof m.delete === 'function') m.delete();
      } catch (_) {
        // ignore cleanup error
      }
    }
  }
}
