import * as THREE from 'three';

/**
 * Analyzes a THREE.BufferGeometry (from an STL or sample model) and extracts:
 * - Welded vertices & non-degenerate indexed triangles
 * - Feature edge segments (above creaseAngleDeg) with exact Convex / Concave classification
 * - Local coordinate frames (u1, u2 pointing into adjacent faces f1, f2; normals n1, n2)
 * - Grouped edge chains for 4 selection modes: 'smart', 'collinear', 'loop', 'segment'
 */
export function analyzeMeshTopology(geometry, creaseAngleDeg = 25) {
  const posAttr = geometry.getAttribute('position');
  if (!posAttr) {
    throw new Error('Geometry is missing position attribute');
  }

  // Convert to unindexed triangle soup if indexed, then weld with tolerance
  const tolerance = 1e-4;
  const invTol = 1 / tolerance;

  const vertices = []; // Array of THREE.Vector3
  const vertMap = new Map();
  const rawIndexCount = geometry.index ? geometry.index.count : posAttr.count;

  const getVertexIndex = (x, y, z) => {
    const kx = Math.round(x * invTol);
    const ky = Math.round(y * invTol);
    const kz = Math.round(z * invTol);
    const key = `${kx}_${ky}_${kz}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      vertices.push(new THREE.Vector3(x, y, z));
      vertMap.set(key, idx);
    }
    return idx;
  };

  const faces = []; // { a, b, c, normal, area }
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let i = 0; i < rawIndexCount; i += 3) {
    const i0 = geometry.index ? geometry.index.getX(i) : i;
    const i1 = geometry.index ? geometry.index.getX(i + 1) : i + 1;
    const i2 = geometry.index ? geometry.index.getX(i + 2) : i + 2;

    const a = getVertexIndex(posAttr.getX(i0), posAttr.getY(i0), posAttr.getZ(i0));
    const b = getVertexIndex(posAttr.getX(i1), posAttr.getY(i1), posAttr.getZ(i1));
    const c = getVertexIndex(posAttr.getX(i2), posAttr.getY(i2), posAttr.getZ(i2));

    if (a === b || b === c || c === a) continue;

    vA.copy(vertices[a]);
    vB.copy(vertices[b]);
    vC.copy(vertices[c]);
    ab.subVectors(vB, vA);
    ac.subVectors(vC, vA);
    cross.crossVectors(ab, ac);
    const len = cross.length();
    if (len < 1e-9) continue;

    faces.push({
      index: faces.length,
      a,
      b,
      c,
      normal: cross.clone().divideScalar(len),
      area: len * 0.5,
    });
  }

  // Build undirected edge map from directed half-edges
  const edgeMap = new Map();
  const addHalfEdge = (u, v, faceIdx) => {
    const min = u < v ? u : v;
    const max = u < v ? v : u;
    const key = `${min}_${max}`;
    let entry = edgeMap.get(key);
    if (!entry) {
      entry = { u: min, v: max, halfEdges: [] };
      edgeMap.set(key, entry);
    }
    entry.halfEdges.push({ from: u, to: v, faceIdx });
  };

  for (let fIdx = 0; fIdx < faces.length; fIdx++) {
    const f = faces[fIdx];
    addHalfEdge(f.a, f.b, fIdx);
    addHalfEdge(f.b, f.c, fIdx);
    addHalfEdge(f.c, f.a, fIdx);
  }

  const cosThreshold = Math.cos(THREE.MathUtils.degToRad(creaseAngleDeg));
  const segments = [];
  let boundaryEdgeCount = 0;
  let nonManifoldEdgeCount = 0;

  for (const entry of edgeMap.values()) {
    if (entry.halfEdges.length === 1) {
      boundaryEdgeCount++;
      continue;
    }
    if (entry.halfEdges.length !== 2) {
      nonManifoldEdgeCount++;
    }

    // Take the first two half-edges sharing this edge
    const he1 = entry.halfEdges[0];
    // Find an opposite half-edge if available, otherwise second half-edge
    const he2 =
      entry.halfEdges.find((h, idx) => idx > 0 && h.from === he1.to && h.to === he1.from) ||
      entry.halfEdges[1];

    const f1 = faces[he1.faceIdx];
    const f2 = faces[he2.faceIdx];
    const n1 = f1.normal;
    const n2 = f2.normal;

    const dot = THREE.MathUtils.clamp(n1.dot(n2), -1, 1);
    if (dot > cosThreshold) {
      // Dihedral angle is smaller than crease threshold -> smooth / flat internal edge
      continue;
    }

    const vaIdx = he1.from;
    const vbIdx = he1.to;
    const pA = vertices[vaIdx];
    const pB = vertices[vbIdx];
    const tangent = new THREE.Vector3().subVectors(pB, pA);
    const length = tangent.length();
    if (length < 1e-6) continue;
    tangent.divideScalar(length);

    // u1 points from the edge into face 1's interior (perpendicular to tangent, in f1's plane)
    const u1 = new THREE.Vector3().crossVectors(n1, tangent).normalize();
    // u2 points from the edge into face 2's interior (perpendicular to tangent, in f2's plane)
    // Note: if he2 is properly oriented (vb -> va), its tangent is -tangent, so n2 x (-tangent) = -n2 x tangent
    const he2Sign = he2.from === vbIdx ? -1 : 1;
    const u2 = new THREE.Vector3().crossVectors(n2, tangent).multiplyScalar(he2Sign).normalize();

    // Convexity test:
    // If face 2's interior direction u2 goes opposite to n1 (u2 . n1 < 0), it bends away -> CONVEX (outside corner).
    // If u2 . n1 > 0, face 2 bends toward n1 -> CONCAVE (inside corner).
    const convexityDot = -u2.dot(n1);
    const type = convexityDot >= 0 ? 'convex' : 'concave';

    // Dihedral angle between normals in degrees (0 = coplanar, 90 = right angle corner)
    const dihedralDeg = THREE.MathUtils.radToDeg(Math.acos(dot));
    // Interior angle between the two faces (e.g. 90 deg for a cube corner)
    const faceAngleRad = Math.acos(THREE.MathUtils.clamp(u1.dot(u2), -1, 1));

    const segId = segments.length;
    segments.push({
      id: segId,
      vaIdx,
      vbIdx,
      pA: pA.clone(),
      pB: pB.clone(),
      midpoint: new THREE.Vector3().addVectors(pA, pB).multiplyScalar(0.5),
      tangent,
      length,
      f1Idx: f1.index,
      f2Idx: f2.index,
      n1: n1.clone(),
      n2: n2.clone(),
      u1,
      u2,
      type, // 'convex' | 'concave'
      dihedralDeg,
      faceAngleRad,
      collinearGroupId: -1,
      smartGroupId: -1,
      loopGroupId: -1,
    });
  }

  // Build vertex -> incident feature segments adjacency
  const vertToSegments = new Map();
  const registerVertSeg = (vIdx, segId) => {
    let list = vertToSegments.get(vIdx);
    if (!list) {
      list = [];
      vertToSegments.set(vIdx, list);
    }
    list.push(segId);
  };

  for (const seg of segments) {
    registerVertSeg(seg.vaIdx, seg.id);
    registerVertSeg(seg.vbIdx, seg.id);
  }

  // Helper to get outward unit direction of segment from a shared vertex
  const getDirFromVertex = (seg, vIdx) => {
    if (seg.vaIdx === vIdx) return seg.tangent.clone();
    return seg.tangent.clone().negate();
  };

  // Helper to check if two segments sharing vIdx have matching face normals
  const normalsMatch = (segA, segB, cosMin = Math.cos(THREE.MathUtils.degToRad(12))) => {
    const direct = segA.n1.dot(segB.n1) >= cosMin && segA.n2.dot(segB.n2) >= cosMin;
    const swapped = segA.n1.dot(segB.n2) >= cosMin && segA.n2.dot(segB.n1) >= cosMin;
    return direct || swapped;
  };

  // 1. Build Collinear Groups (strictly straight segments split by STL triangulation)
  const collinearCos = Math.cos(THREE.MathUtils.degToRad(5));
  const collinearGroups = buildEdgeChains(segments, vertToSegments, (segA, segB, vIdx) => {
    if (segA.type !== segB.type) return -1;
    const dA = getDirFromVertex(segA, vIdx);
    const dB = getDirFromVertex(segB, vIdx);
    // For two segments continuing straight through vIdx, dA and dB point in opposite directions (dA . dB ≈ -1)
    const alignment = -dA.dot(dB);
    if (alignment < collinearCos) return -1;
    if (!normalsMatch(segA, segB, Math.cos(THREE.MathUtils.degToRad(8)))) return -1;
    return alignment;
  });
  collinearGroups.forEach((g, idx) => {
    g.segmentIds.forEach((sId) => {
      segments[sId].collinearGroupId = idx;
    });
  });

  // 2. Build Smart Groups (merges collinear segments AND smooth curved arcs like cylinder rims)
  const smartTurnCos = Math.cos(THREE.MathUtils.degToRad(34));
  const smartGroups = buildEdgeChains(segments, vertToSegments, (segA, segB, vIdx) => {
    if (segA.type !== segB.type) return -1;
    const dA = getDirFromVertex(segA, vIdx);
    const dB = getDirFromVertex(segB, vIdx);
    const alignment = -dA.dot(dB); // 1.0 = straight line
    if (alignment < smartTurnCos) return -1;
    // Also require similar dihedral angle so different creases don't merge accidentally
    if (Math.abs(segA.dihedralDeg - segB.dihedralDeg) > 18) return -1;
    return alignment;
  });
  smartGroups.forEach((g, idx) => {
    g.segmentIds.forEach((sId) => {
      segments[sId].smartGroupId = idx;
    });
  });

  // 3. Build Connected Loop / Chain Groups (connected components of same convexity, preferring planar loops)
  const loopGroups = buildLoopGroups(segments, vertToSegments);
  loopGroups.forEach((g, idx) => {
    g.segmentIds.forEach((sId) => {
      segments[sId].loopGroupId = idx;
    });
  });

  return {
    vertices,
    faces,
    segments,
    vertToSegments,
    collinearGroups,
    smartGroups,
    loopGroups,
    isWatertight: boundaryEdgeCount === 0 && nonManifoldEdgeCount === 0,
    boundaryEdgeCount,
    nonManifoldEdgeCount,
  };
}

/**
 * Greedily pairs compatible incident segments at vertices to form ordered chains/loops.
 */
function buildEdgeChains(segments, vertToSegments, scoreFn) {
  const visited = new Uint8Array(segments.length);
  const groups = [];

  // For each vertex, precompute best mutual pairings so chains don't branch unpredictably
  const nextAtVertex = new Map(); // key: `${segId}_${vIdx}` -> partnerSegId

  for (const [vIdx, incidentIds] of vertToSegments.entries()) {
    if (incidentIds.length < 2) continue;
    const pairs = [];
    for (let i = 0; i < incidentIds.length; i++) {
      for (let j = i + 1; j < incidentIds.length; j++) {
        const sA = segments[incidentIds[i]];
        const sB = segments[incidentIds[j]];
        const score = scoreFn(sA, sB, vIdx);
        if (score > 0) {
          pairs.push({ a: sA.id, b: sB.id, score });
        }
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    const usedInVert = new Set();
    for (const p of pairs) {
      if (!usedInVert.has(p.a) && !usedInVert.has(p.b)) {
        usedInVert.add(p.a);
        usedInVert.add(p.b);
        nextAtVertex.set(`${p.a}_${vIdx}`, p.b);
        nextAtVertex.set(`${p.b}_${vIdx}`, p.a);
      }
    }
  }

  for (let i = 0; i < segments.length; i++) {
    if (visited[i]) continue;
    visited[i] = 1;

    const chain = [i];

    // Walk forward from vbIdx
    let currId = i;
    let currVert = segments[currId].vbIdx;
    while (true) {
      const nextId = nextAtVertex.get(`${currId}_${currVert}`);
      if (nextId === undefined || visited[nextId]) break;
      visited[nextId] = 1;
      chain.push(nextId);
      const nextSeg = segments[nextId];
      currVert = nextSeg.vaIdx === currVert ? nextSeg.vbIdx : nextSeg.vaIdx;
      currId = nextId;
    }

    // Walk backward from vaIdx
    currId = i;
    currVert = segments[currId].vaIdx;
    while (true) {
      const prevId = nextAtVertex.get(`${currId}_${currVert}`);
      if (prevId === undefined || visited[prevId]) break;
      visited[prevId] = 1;
      chain.unshift(prevId);
      const prevSeg = segments[prevId];
      currVert = prevSeg.vaIdx === currVert ? prevSeg.vbIdx : prevSeg.vaIdx;
      currId = prevId;
    }

    let totalLen = 0;
    for (const sId of chain) totalLen += segments[sId].length;

    groups.push({
      id: groups.length,
      type: segments[i].type,
      segmentIds: chain,
      totalLength: totalLen,
    });
  }

  return groups;
}

/**
 * Builds broader loop/perimeter groups of connected feature edges of the same type
 * that share a common face normal or form a continuous perimeter.
 */
function buildLoopGroups(segments, vertToSegments) {
  const visited = new Uint8Array(segments.length);
  const groups = [];

  for (let i = 0; i < segments.length; i++) {
    if (visited[i]) continue;
    const seed = segments[i];
    visited[i] = 1;
    const comp = [i];
    const queue = [i];

    while (queue.length > 0) {
      const currId = queue.shift();
      const curr = segments[currId];
      const verts = [curr.vaIdx, curr.vbIdx];
      for (const vIdx of verts) {
        const neighbors = vertToSegments.get(vIdx) || [];
        for (const nId of neighbors) {
          if (visited[nId]) continue;
          const cand = segments[nId];
          if (cand.type !== seed.type) continue;
          // Check if they share at least one approximately coplanar adjacent face normal
          // (e.g. all 4 edges around the top face of a box share the top face normal!)
          const sharesFacePlane =
            curr.n1.dot(cand.n1) > 0.85 ||
            curr.n1.dot(cand.n2) > 0.85 ||
            curr.n2.dot(cand.n1) > 0.85 ||
            curr.n2.dot(cand.n2) > 0.85;
          if (sharesFacePlane) {
            visited[nId] = 1;
            comp.push(nId);
            queue.push(nId);
          }
        }
      }
    }

    let totalLen = 0;
    for (const sId of comp) totalLen += segments[sId].length;

    groups.push({
      id: groups.length,
      type: seed.type,
      segmentIds: comp,
      totalLength: totalLen,
    });
  }

  return groups;
}

/**
 * Returns the list of segment IDs corresponding to clicking `segId` under `selectionMode`.
 */
export function getGroupSegmentIds(topology, segId, selectionMode = 'smart') {
  const seg = topology.segments[segId];
  if (!seg) return [];

  if (selectionMode === 'segment') {
    return [segId];
  }
  if (selectionMode === 'collinear') {
    const g = topology.collinearGroups[seg.collinearGroupId];
    return g ? g.segmentIds : [segId];
  }
  if (selectionMode === 'loop') {
    const g = topology.loopGroups[seg.loopGroupId];
    return g ? g.segmentIds : [segId];
  }
  // Default: 'smart'
  const g = topology.smartGroups[seg.smartGroupId];
  return g ? g.segmentIds : [segId];
}
