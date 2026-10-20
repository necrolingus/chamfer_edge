# EdgeCraft STL — Selective Edge Chamfer & Fillet for TinkerCAD

A client-side-only 3D CAD utility built for **TinkerCAD** and 3D printing users who need to selectively **Chamfer** (flat angled bevel) or **Fillet** (smooth rounded radius) individual edges of an exported `.stl` file.

## Features
- **100% Client-Side**: Runs entirely in your browser using Three.js and `manifold-3d` WebAssembly CSG boolean operations. No files are ever uploaded to a server.
- **Smart STL Edge Healing**: Automatically detects crease edges and merges split triangle segments along flat faces and smooth circular rims (like cylinder tops and mounting holes) into single one-click selectable edges.
- **Convex & Concave Edge Support**:
  - **Convex (Outside Corners — Cyan)**: Subtracts a precision chamfer or tangent fillet cutter volume.
  - **Concave (Inside Corners — Pink)**: Unions a watertight internal chamfer wedge or fillet radius into inside corners (e.g., strengthening an L-bracket bend).
- **Chamfer & Fillet Operations**:
  - Symmetric or Asymmetric (Distance 1 × Distance 2) Chamfers with direction flip.
  - Smooth tangent circular/elliptical Fillets with adjustable segment resolution.
  - Real-time 3D live preview mesh before applying.
- **Multi-Step Workflow**: Apply different chamfer/fillet sizes to different edges sequentially with full **Undo / Redo** (`Ctrl+Z` / `Ctrl+Y`) and one-click Binary **STL Export**.

## Running Locally
Because the app uses native ES Modules (`<script type="module">`), serve the folder with any static HTTP server:

```bash
# Using Python
python -m http.server 8080

# Or using Node.js npx serve
npx serve .
```

Then open `http://localhost:8080` in your browser.
