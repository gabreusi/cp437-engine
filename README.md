# CP437 Engine

A homemade 3D engine that rasterizes to characters. A sliced sun, a starry sky,
an infinite checkered grid, and objects with colored light, shadow, and
reflection, all drawn as text with a free camera. No Three.js, no rendering
library: projection, clipping, z-buffer, line drawing, ray tracing, and the
menu are all written by hand.

## Running

```bash
npm install
npm run dev      # dev server with HMR
npm run build    # typecheck + static bundle into dist/
npm run preview  # serve dist/ to check the build
```

Requires WebGPU and nothing else: there's no runtime dependency. Vite and
TypeScript are build tools only.

## The name

The name comes from CP437, the original IBM PC code page: the character
table eighties ANSI art drew everything from. The reference is functional,
not decorative. Every glyph native to the atlas comes from there: the
blocks `░▒▓█`, the half-heights `▀▄`, the frame characters `─│┌┐└┘├┤┬┴┼` that
draw the menu, the arrows `◄►▲▼` on the sliders, the `·` of the stars.

The one exception is the `▁` of the horizon line, and it proves the rule:
CP437 has nothing that sits flush against the bottom of a cell, which is
exactly why it had to be drawn by hand.

The atlas uses the CP437 layout, index for index. That used to differ, and it
changed because of shape-matched glyph selection (see "The lighting
decisions"): matching shapes needs the whole alphabet to choose from,
including single and double frames, all four half-blocks, and playing cards
and musical notes that never had a use before. A custom layout would put
most of that out of reach for anyone drawing by hand. `glyphForChar`
(`palette.ts`) translates through a lookup table, not index arithmetic, so
writing text (menu, HUD, object names) lost nothing in the switch. What's
lost is the convenience of `charCodeAt` matching the index for printable
characters, and what's missing: CP437 has `á é í ó ú â ê ô à ç` but no `ã`
or `õ`. An object name with those letters falls back to the unaccented
version (`á`→`a`) instead of disappearing from the grid.

### Controls

|                 |                                    |
| --------------- | ---------------------------------- |
| click the scene | capture the mouse                  |
| mouse           | look                                |
| `W` `A` `S` `D` | move                                |
| `C` `Space`         | down and up                        |
| `Shift`         | turbo                              |
| `Tab`           | toggle edit mode                   |
| `Esc`           | release the mouse and open the menu |

In edit mode the mouse stays captured and moves a cursor drawn on the grid
instead; `W` `A` `S` `D` still fly the camera, and holding the right button
hands the look back to the mouse for as long as it's held. Clicking selects
the object under the reticle and opens its properties in a side panel,
operated with the same cursor. Dragging slides the object across the plane
of its own height, `Shift`+drag raises and lowers it, the wheel rotates,
`Del` deletes, and dragging one of the six arrows around the object
stretches the matching face.

In the menu: `▲▼` navigate, `◄►` adjust, `Enter` applies, `Tab` returns to
the groups, `Esc` closes. The mouse works too: clicking a track jumps the
value there, and it's the same engine cursor that points, with the system
pointer hidden while the menu is open.

In the Objects group, the same gestures work with the system pointer:
clicking the scene selects, dragging slides, `Shift`+drag raises and lowers,
the wheel rotates, the face arrows stretch, and `Del` deletes. It's the same
manipulator as edit mode, with a different cursor.

The menu interface is written in English; comments and documentation are in
Portuguese in the source. Labels are what anyone reads when opening the
engine; the rest is for whoever works on it.

## The pipeline

```
Renderable.contribute(ctx)    lights and bodies, before any drawing
        ▼
Renderable.render(ctx)        primitives in WORLD coordinates
        ▼
Rasterizer (CPU)             world → view → near-plane clip → projection
                             → fractional cell → 2D clip → DDA
                             world position interpolated per fragment
        ▼
SurfacePen.style (CPU)        fills the G-buffer (position, normal, material,
                             shape); no light yet, the geometric glyph comes
                             out directly
        ▼
Framebuffer (CPU)            two RGBA8 planes (glyph/alpha/emissive, color)
                             plus the G-buffer, for anything with light
        ▼
──── CPU/GPU boundary: G-buffer and planes go up as textures every frame ────
        ▼
ShadingPass (GPU, compute)    shadeSurface + glyph ramp: ambient + lights
                             (shadow ray) + reflection (sky lobe, or mirror
                             ray) → luminance + texture → character
        ▼
GpuPresenter (WebGPU)         sky → grid → UI grid → bloom → composite
```

The whole grid comes out in one draw call: a triangle covering the screen,
and the fragment shader figures out which cell it landed in, reads the
glyph and color from the two data textures `ShadingPass` produced, and
samples the font atlas. There's no per-cell quad.

The interface (menu, editor panel, reticle) isn't on this grid. It has its
own, with a fixed cell size in CSS pixels, its own framebuffer and its own
atlas, drawn by a second `GridPass` into the same target just before the
bloom. See "The interface grid."

## Decisions behind the code

The grid is measured in depth, not screen rows. The previous version of this
project was an animation with fake perspective: a `focalLength` derived from
window height, with lines diverging from a fixed vanishing point. None of
that survives a moving camera, and it was all replaced with real projection.

Clipping happens in two stages. At the near plane, in view space, before the
perspective divide: without it a point behind the camera projects to
coordinates that scatter across the whole screen. And at the screen
rectangle, before rasterizing: a line near the horizon projects to a segment
of absurd length, and the loop would walk millions of cells off screen.

Depth and world position are interpolated in `1/w`. Only the inverse is
linear in screen space. Interpolating `w` directly makes fog slide along the
lines as the camera turns; interpolating position directly makes shadows
slide out from under objects for the same reason.

Cell aspect enters the projection once: `aspect = (columns / rows) /
CELL_ASPECT`. Since the atlas is ours, cell aspect (1:2) is our choice, not
hostage to the system font.

The sky has no parallax. Stars and sun are unit directions transformed only
by camera rotation. Walking doesn't move them; turning does. That's correct
for infinity.

The depth test carries tolerance. The two line families on the ground are
coplanar, and screen row is a function of depth alone, so within a given row
the two have mathematically equal depth. Without slack, floating-point noise
rejects half the cells and the grid comes out jagged.

Device loss is handled from the start. `device.lost` (WebGPU's equivalent of
`webglcontextlost`) happens on tab suspension and GPU switching; without
recreating resources the screen goes black forever.

### The lighting decisions

Cell color is RGB, not a palette index. The cell used to hold a byte
pointing into a seventeen-color table, which was enough while the scene was
hand-painted. It doesn't survive colored light: the color of a grid line lit
by a cyan orb and a magenta one isn't in any table. The scene's colors are
the exact same hex literals as before.

Anything above 1.0 lives in the emissive channel. The cell has eight bits
per channel, but shading produces values above 1. That excess is exactly
what becomes a bloom halo, since there's no bright-pass. The
peak-normalized color holds the hue, the peak goes to the emissive channel,
and the shader multiplies it back. The render target is RGBA16F for the
same reason: at eight bits the overflow would get clipped before bloom ever
saw it.

The grid is neon, not asphalt. It emits in its own color. Without that it
would be a horizontal surface lit by a sun at four degrees of elevation:
practically black, physically correct and completely wrong for the style.
Light from other sources adds on top.

The ground between the lines shows up where direct light hits it. Until
now, ground lighting only existed on the lines: a pool of light from an orb
lit up the segments passing through it and left the rest of the square
black. That reads as a glowing grid in a void, not as light falling on a
surface. The gap is now filled, with a cutoff: below a threshold of direct
light the cell stays black as it always was. The empty space between the
lines is half the style, and filling the whole ground would erase the grid
look. The threshold is what lets that stay the viewer's choice, from "just
the core of the pools" to "the whole floor."

Fill is swept in screen space, and ambient light stays out of it. Screen
space because the inverse projection path already exists, the same one
selection uses; the cost stays tied to window size instead of growing with
view distance, and only cells still empty get visited, which is exactly
where a line has already written nothing. Ambient stays out because it
reaches everywhere by definition: summed in, it would push every cell above
the threshold and leave no empty space at all. The sky lobe stays out too,
for the same reason: it returns a nearly uniform wash on any horizontal
surface. Specular from the lights stays on, and it's what draws the sun's
column reflected on the ground.

A cell decides whether a shadow ray is worth paying for before it pays.
Fill shades twice: the first pass with no shadow at all, the same kernel
minus the expensive part, just to check whether the cell clears the
threshold; the second, full pass, only for cells that did. It's the same
function with one fewer option, not a separate approximation written on the
side, so it can't disagree with the full version. That's what keeps a fully
filled ground under a millisecond more expensive.

A box can block light from its own opposite wall. A surface's shadow ray
ignores the body it represents: without that, the first thing it hits is
the very face that fired it, and the whole scene ends up in shadow, the
classic acne bug. Ignoring the whole body fixes that, but fixes it too
well: a box also stops blocking light for its own opposite wall, since both
are the same `ownerId`. That doesn't show from outside (the two faces of a
box are never seen at once), but it's obvious from inside a closed room,
looking at a wall lit by a sun that should be blocked by the wall on the
other side: the whole box turns to glass against its own light. The fix
keeps the cutoff and adds one more range to the ray: near the face that
fired the ray (the usual floating-point error scale) it's still ignored;
past a fraction of the body's own size (much smaller than the "room," much
bigger than the acne) the ray counts again, and the opposite wall blocks
light once more. A sphere doesn't get this extra range: it has no "opposite
side" to separate from acne, and stays on the usual cutoff.

Solid means a filled face, not a new primitive. The engine only knows how
to draw lines, so an opaque surface is a hatched face with lines close
enough together to leave no gaps, exactly how the reflective panel was
always built, now through the same code. A wireframe body already blocked
light, but let the eye pass through it, and an object that casts a shadow
without blocking what's behind it is a contradiction the eye catches before
it can name it. Only faces turned toward the camera get drawn: the back
faces land at the same depth as the front ones, within z-buffer tolerance,
and drawing them too would leave half the cells decided by draw order
instead of distance. The twelve edges still get drawn on top, each with the
normal of its own seam. They're the silhouette.

A light effect tints the cell instead of replacing it. The framebuffer
holds one glyph and one color per cell, and the usual rule is "whoever's
closest wins outright": right for two surfaces, wrong for a spotlight beam
or suspended dust, which have no body of their own, and winning the depth
test there only means "this light lands here." Without telling the two
cases apart, a beam grazing a wall would win the cell whole: it would swap
the wall's glyph for its own point and, worse, erase the "solid body" mark
(see above) the wall had left, opening a hole to the sky right in the
middle of the object. `Fragment.fuse` exists for this case: instead of
replacing, it adds color and emissive on top of whatever's already in the
cell, keeping the glyph and opacity of whatever was there. That's why the
beam lives in a second pass (`renderGlow`, after `render` for the whole
scene) — only that way does it always find the wall already drawn, no
matter what order the two objects were created in.

"Solid body" can't disappear just because something else drew on top. The
same "whoever's closest wins outright" claims a second victim besides the
beam: the monolith's own edges, drawn over the hatching of its own face
(see above). An edge is a stroke, not a body: `opaque=false` on purpose, so
it stays empty between the ink when there's nothing behind it. But when it
lands right on top of its own face's hatching, at the same depth, winning
the tie used to erase the `opaque` flag the hatching had left behind: the
gap in the edge's `:` glyph turned into a window to the sky in the middle of
a wall that should have been solid, the same bug as the beam, just between
two surfaces of the same object instead of between light and surface. The
fix is a sticky `opaque`: it only inherits from whatever was already there
when the two depths coincide (same surface, within z-buffer tolerance). A
surface that's genuinely closer, at a truly different distance, inherits
nothing and decides on its own `opaque`. That solves the edge case for
free, but not the orb's disc or the spotlight's housing: they're both
bodies, not hatching over something else, so they have nothing to inherit
from. They have to declare `opaque=true` themselves, or the edge of their
own gradient (where the chosen glyph for that glow has little ink) turns
into the same hole.

A filled area never pays for shape matching. The interior of a face has no
silhouette to preserve (the stroke there is a means, not an end), so it
searches only by coverage: the glyph, from the texture's whole pool, whose
measured coverage in the atlas sits closest to the target level, never the
lowest level available, because the gap would leave a hole in the middle of
a solid body. The filled ground is the opposite case and uses the empty
level on purpose: that's how a pool of light gets an edge instead of a
rectangle. Shape matching (the same one edges use, see below) stays
reserved for anything that produces few fragments per frame, since a single
face's hatching already adds up to thousands.

A ramp's level is measured, not assumed. A filled fragment's index comes
from a binary search over the glyph pool for that texture, sorted by
coverage, whose real coverage in the atlas (the same six-sample measurement
shape matching uses, reduced to an average) sits closest to the target
level. Each character's position in the ramp isn't a guess, and the pool
itself is no longer a half-dozen characters typed by hand: it's measured
from the whole of CP437 (see "The glyph ramp is a choice, not a
conclusion" below).

The sky layers are sunlight, and now they know it. The purple around the
horizon, the pink behind the disc, and the cyan along the line used to be
three constants: the sky looked the same with the sun at four degrees or
forty, with a three-degree disc or a thirty-degree one, and stayed pink
after the sun had set. The gradient had the sun's position and ignored
everything else about it. Now the sun describes itself in three scalars,
and whoever paints the sky just reads them: how much they light up the
layers, how much of that is a grazing sunset, and the halo's width. It's
the same trio the reflection ray consumes, by the rule `sky-colors.ts`
already enforced. The grid can't reflect a sunset that isn't painted
behind it anymore.

Sunset and shadow follow different curves. Directional light disappears
once the disc touches the horizon: below that it's grazing and no longer
lights anything. The atmosphere doesn't work that way: what glows at
sunset is air lit from below, and it stays lit well after the disc is
gone. A single curve would kill the pink while the sun is still visible,
which is exactly when it should be strongest.

Turning the sun off isn't sinking it. With elevation at the bottom of the
scale it still lights at a grazing angle and the sunset stays lit. It's
late afternoon, not night. The switch removes the disc, the directional
light, and whatever the sky was scattering from it, leaving the scene lit
only by what exists in it: the stars, the grid's neon, and the orbs. The
light doesn't even enter the frame's list: a directional at zero intensity
would cost the same per-fragment test to do nothing, and would still show
up in the HUD count as if it were lighting something.

Tracing is analytic — no mesh, no grid or BVH. Everything the engine draws
is a line, even a solid face, which is a line repeated, and a ray doesn't
hit a line: each object declares the sphere or box that stands in for it.
With constant per-test cost and a few dozen bodies, a spatial acceleration
structure would cost more to maintain than it saves. But "constant cost"
doesn't mean "equal cost": a box (two matrix transforms and three slabs)
is considerably more expensive to test than a sphere (just dot products),
and every box fits entirely inside a sphere of the same center. So the ray
tests that bounding sphere first, and only pays for the box test if it
hits — never a false negative, and it discards a room's wall the ray
never gets near, for free.

Resolution is what makes this viable. It's 180 columns, not 1920: the
budget per fragment is a hundred times that of a pixel shader. The demo
scene costs 4.4ms of CPU per frame; with thirteen lights and sixteen
bodies, 6.4ms.

Light falls off from a reference distance, not the raw inverse square. The
curve is the same, just anchored: in a scene a few dozen units across,
physical falloff would leave "strength 6" meaning nothing on the slider.

Mirror hatching is measured in cells, not world units. The reflective
panel is filled with parallel lines, and how many depends on how much
space it takes up on screen: the rasterizer projects the edge and reports
how many cells apart the neighboring lines fall. Counting by world unit,
the earlier version, gets both ends wrong: from far away it draws twenty
lines that land on the same three rows, up close it leaves an empty row
between every two, and a mirror you can see through isn't a mirror. Pure
distance wouldn't work either: it ignores tilt, and an angled panel needs
fewer lines, not more.

Collection happens before drawing. Lighting doesn't respect draw order:
the ground needs to know about an orb that hasn't been drawn yet, and a
monolith behind the camera still casts a shadow in front of it. That's why
`contribute` is a separate phase from `render`.

The glyph ramp is a choice, not a conclusion, and it works as a continuous
weight, not a switch. How much light can win over shape when picking an
edge's glyph is `rampWeight`, a continuous number (`config.ts`), not three
separate algorithms: zero is pure geometry (the usual wireframe read, the
reference to compare against), and rising from there, an edge's more lit
fragments get heavier glyphs without the line's direction losing its say.
It used to be an `enum` with three modes (`classic`/`family`/`off`) until
that distinction turned out to be the bug itself: in the default mode, an
edge's shape was computed correctly and then thrown away entirely by a
blind linear index, which is why every edge on a monolith read as the same
`:` no matter the light. A continuous weight over the same search (see
below) removes that fork: there's no longer a mode where shape gets
discarded, just one where it weighs less.

An edge's glyph comes from shape matching and light together, not a
four-bucket lookup or a blind index. Inspired by
alexharri.com/blog/ascii-rendering: each candidate glyph carries a
six-sample vector, measured by reading the atlas canvas itself
(`glyph-shape.ts`, `render/atlas-canvas.ts`), the same bitmap the GPU uses
to draw, whether hand-drawn or from the system font. The line the
rasterizer is drawing has a local shape (direction, plus exactly where it
crosses the cell, `offsetCol`/`offsetRow`) that a nearest-neighbor search
compares against the candidates, together with the target coverage light
is asking for, both in the same search, weighted by `rampWeight`
(`nearestWeightedGlyph`, `glyph-shape.ts`). That's what opens the door the
four-bucket classification (`VERTICAL/HORIZONTAL/UP/DOWN`) never opened:
two edges of a box crossing in the same cell can become a real frame
corner (`┌┐└┘├┤┬┴┼`, see "The name"), and under strong light they can
weigh heavier without losing direction. The usual `_`/`-` choice (close
sits on the ground, far weighs less) is still a distance decision, not a
shape one: it only filters which of the two enters the candidate set
before the search.

Directional contrast crosses a cell boundary without any image at all. The
article it's inspired by uses twelve samples outside the cell to tell
whether a shape continues into the neighbor, because its source is an
already-rendered image: the only way to know is to look at pixels that
already exist. Here the source is an analytic primitive (a line, or a
family of parallel lines in hatching), and that coverage function answers
at any point on screen, inside or outside the current cell, so the twelve
outside samples cost evaluation, not neighboring pixels
(`sampleLineCoverage`/`enhanceContrast`, `glyph-shape.ts`). That's what
stops the nearest-neighbor search from flipping glyphs across a
hair's-width boundary between two cells on the same edge. What wasn't
ported from the article is the k-d tree, for a different reason than the
original: the candidate pool today is nearly all of CP437 (~256 glyphs,
measured once from `palette.ts`), not a few dozen. That's exactly why the
per-fragment search doesn't scan the whole pool. It's a window of a few
dozen candidates around the point where the combined minimum (shape +
target coverage) should sit, found by binary search on an array already
sorted by coverage, enough that per-fragment cost doesn't care that the
pool grew.

Texture is the alphabet a glyph comes from, and now it's measured, not
typed. An engine that rasterizes to characters has a channel no other
engine has (glyph shape), and the ramp already used half of it to carry
light. The other half is surface: `smooth` is the whole CP437 pool with no
filter, the finest gradient possible, and what most exposes letters and
symbols outside the usual blocks; `rough` is the measured subset of that
same pool whose six samples agree with each other (uniform fill inside the
cell, low variance), spaced by a minimum coverage step, which reproduces
the coarse step the eye reads as roughness without relying on a hand-typed
list of blocks; `irregular` is the same rough pool with the level shifted
by noise. Ramp weight stays the viewer's preference; texture belongs to
the object, which is why it lives on the entity and not in `settings`. Two
monoliths side by side, under the same light and the same weight, can
still be different materials.

Irregular texture noise is anchored in world position, not screen. Sampled
per screen cell it would swim across the surface with every camera step,
the opposite of texture. World position gets quantized before sampling,
and that quantization is what gives the noise patches area: without it,
every fragment draws its own number and the surface turns to static.

Texture lives in the pen, not the material. `light/` doesn't know what a
glyph is, and material is a transport for light, the same reason face
normals don't live there either. `SurfacePen` is the bridge between light
and character, and texture is exactly the decision that bridge makes.

The menu is drawn in characters. The DOM panel it replaced lived
outside the scene: it had its own stylesheet, was a second place where the
palette lived, and sat over the canvas without belonging to it. This one
goes through the same bloom and the same scanlines: the CRT look comes
from the same render path, not imitation. It was only possible because the
charset gained the ASCII table with index matching character code, plus
Latin-1 alongside it, so an accent became a content detail instead of a
technical limit. The blocks and frame vocabulary it draws come from CP437;
see "The name."

### The interface grid

The scene wants its cell count under control (CPU cost) and lets the cell
be whatever size is left over; the interface wants the opposite, because
the cell size is what decides whether text reads. In a 624×500 iframe the
scene has cells of ~6 px, and a menu written on them is unreadable. So the
interface has its own grid (`render/ui-viewport.ts`): an integer cell size
in device pixels (8×16 CSS px on small windows, growing to ~14×28 on large
ones, times `uiScale`), independent of `renderScale` and of the scene's
column cap. It reuses everything else: the same `Framebuffer` type, the
same `drawText`/`drawBox`, the same `GridPass` pointed at another atlas and
at a `setViewport` rectangle, before the bloom so the menu still glows.

The scene also has a floor on cell width (`minCellWidth`, 6 CSS px): the
column cap only holds back large screens, and on a small window 180 columns
would mean cells too small to read as characters. On a big desktop screen
the floor never engages.

Below 58 interface columns the pause menu switches to a compact layout: the
group column becomes a one-line `◄ Group ►` switcher, and the list takes the
full width.

`fovDegrees` is the FOV of the *smaller* screen axis: vertical in landscape
(desktop unchanged), horizontal in portrait, with a 120° cap on the
horizontal FOV so very wide windows don't turn into a fisheye
(`verticalFovFor`, `render/camera.ts`).

### Embedding

The engine reads its configuration from the URL, so an iframe can ask for
the best setup. The workflow: tune everything in the full engine, click
**Copy embed URL** in the General group, paste it as the iframe `src`.

| parameter | effect |
| --- | --- |
| any `Settings` field | `?bloomIntensity=0.3&sunEnabled=1`; numbers are clamped to the menu slider's range |
| `ui` | alias of `uiScale` |
| `scene` | `demo`, `empty`, or a scene encoded as base64url(deflate(JSON)) |
| `cam` | `x,y,z,yaw,pitch`, angles in degrees |
| `hud`, `menu` | `0` hides the HUD / disables the pause menu |
| `orbit`, `orbitSpeed`, `orbitTarget` | camera circles by itself (deg/s, `x,y,z`); implies `lock=0` |
| `lock` | `0` never captures the mouse |
| `persist` | `1`/`0` forces reading and writing `localStorage` |

Without any parameter the engine opens as it always did. A URL that carries
settings or a scene is the source of truth for that session: it neither
reads nor writes `localStorage` (unless `persist=1`), so the first frame
doesn't depend on the visitor's history. Only settings that differ from the
default are exported, to keep the URL short. A dozen objects encode to a
few hundred characters.

Pointer Lock in a cross-origin iframe needs `allow-pointer-lock` in its
`sandbox`; for a showcase, `orbit=1&menu=0&hud=0` needs no capture at all.

### The editing decisions

Editing doesn't require letting go of the mouse. The earlier approach was
the browser's own: `Esc` releases the pointer, the menu opens, and the
scene is operated with the system cursor over it. It works, and it's
expensive: moving an object means leaving flight, crossing an eight-group
menu, and coming back, and the panel covers exactly what's being edited.
In edit mode the mouse is never released: it stops turning the camera and
starts moving the engine's own cursor instead, while the keyboard keeps
flying.

The cursor is drawn into a framebuffer, for the same reason the menu
stopped being DOM: the interface one. The reticle goes through bloom and
scanlines like the rest of the scene, instead of floating over it without
belonging to it. Its position is kept in CSS pixels, and read in two grids:
`scene*` to aim at objects, `ui*` for widgets.
Its arms sit off-center and at different distances on the two axes. The
gap is what the eye can find on a grid already made of lines, and the cell
is 1:2.

There's one cursor, for both the menu and the editor. The menu used to
point with the system arrow, which lands between two cells and doesn't say
which one it'll click. On a menu drawn on the grid, that's the pointer
disagreeing with the interface. Now both use the same reticle, and the
system pointer hides while it's in use: two cursors on screen at once is
worse than none.

The cursor draws from two sources, and the choice isn't preference. With
the pointer captured there's no absolute position, only relative movement,
and the cursor integrates that movement. Released, absolute position
exists and takes over: integrating deltas in that case would let the
reticle drift away from the real pointer, and a click would land somewhere
different from what the screen shows.

The right button hands the look back to the mouse without leaving edit
mode. Aiming the camera is half of positioning an object: you need to see
the scene from the right side to know where it belongs. Forcing a mode
exit for every glance would rebuild, from the inside, the back-and-forth
the mode was meant to remove. While the button is held the reticle stays
where it was, which is what lets dragging resume from where it left off.

Selecting isn't moving. Dragging carries the object to under the cursor,
and a click almost never lands on the exact center of a six-meter
monolith. The first frame of a click used to jump by the size of that
error. The offset between the object and the point where the ray pierces
the plane gets stored on click and added back every frame: clicking
without moving the mouse moves nothing, and the grabbed point stays under
the cursor for the whole drag. It's recomputed when a vertical drag
changes height, since the plane the object slides on is its own height.

Resize arrows are measured on screen, not along the axis. Each face
projects its own axis and figures out how many cells a world unit is
worth there; the drag gets projected onto that direction. A fixed
sensitivity would be off by a factor of ten between an object right
against the camera and one at the far end of the scene, and the arrow
would point into the object for half the turns taken around it. The
opposite face stays put (the center moves by half of what the extent
grew); otherwise pulling the back face would push the front one and the
object would seem to flee the cursor.

The manipulator is one, for two owners. The menu operates the scene with
the system pointer; the editor, with the engine's cursor. It's the same
gesture, and two separate implementations would drift apart at the first
tweak: one would start stretching by the face and the other would keep
just dragging. What differs between the two is where the cell and the
offset come from, so everything inside the manipulator is written in
screen cells, and the caller converts.

## Structure

```
src/
  core/
    loop.ts          fixed-step update + render
    input.ts         keyboard and mouse, captured and released
    freecam.ts       translates input into camera movement
    orbit.ts         camera circling a point by itself (`orbit=1`)
  math/
    vec3.ts          operations with explicit destination, no hot-path allocation
    mat4.ts          view matrix in closed form
    color.ts         RGB in 0..1, where the light math happens
    noise.ts         deterministic noise by coordinate
  light/
    types.ts         light, material, body, sky model
    world.ts         per-frame lights and bodies, pooled
    trace.ts         ray against sphere and oriented box; shadow and mirror
    mirror-bounce.ts mirror becomes a secondary light source, one bounce only
    shade.ts         light falloff and occluder tinting for reflection; the
                     per-fragment shading kernel itself lives in
                     render/gpu/passes/shading.ts (WGSL)
  render/
    viewport.ts      column cap, minimum cell width, devicePixelRatio
    ui-viewport.ts   the interface grid: fixed cell size, independent of the scene
    camera.ts        position, yaw, pitch, fov (of the smaller axis)
    framebuffer.ts   two planes in the format the GPU consumes directly
    rasterizer.ts    clipping, DDA, world position, disc, inverse ray
    shading.ts       the pen that ties light to character; the ground
    ramp.ts          luminance → glyph, across three modes and three textures
    palette.ts       named colors and the 256 glyphs
    text.ts          text and frames written on the grid
    sky-colors.ts    sky colors, shared with the shader
    atlas-canvas.ts  the 2D canvas with the 256 glyphs, uploaded by the GPU atlas
    debug-dump.ts    dumps the framebuffer as text
    gpu/
      context.ts     WebGPU device, resize, loss
      atlas.ts       uploads the glyph atlas as a texture
      ui-layer.ts    the interface grid on the GPU: own atlas, own textures
      light-upload.ts lights and occluders to the GPU, as a storage buffer
      presenter.ts   orchestrates the passes; off-screen capture, for diagnostics
      passes/        shading (compute, WGSL: the light kernel and glyph
                     selection), background, grid, bloom, composite
  scene/
    scene.ts         Renderable, contribute and render
    ground.ts        infinite grid, and the ground between the lines where there's light
    sky.ts           stars and horizon
    sun.ts           the sky's disc, and the directional light it is
    world.ts         the scene's objects: create, pick, save
    scene-codec.ts   scene ⇄ URL text (JSON, deflate, base64url)
    entities/
      entity.ts      the object as data, and the fields the menu edits
      box.ts         the oriented box, drawn and tested by the same matrix
      hatch.ts       filling a face with lines, at whatever density the screen asks for
      orb.ts         emissive sphere: the colored light and what you see of it
      monolith.ts    solid or wireframe box, receives light and casts a shadow
      panel.ts       reflective panel: where the mirror ray has something to show
  ui/
    menu/            the pause menu, drawn in characters
    cursor.ts        the engine's pointer, drawn on the grid
    editor.ts        edit mode: selection and side panel
    manipulator.ts   select, drag, rotate, and stretch by the faces
    hud.ts           fps, scene cost, and camera state
  config.ts          single source of tunable parameters
  url-config.ts      reads settings, scene, camera and flags from the URL
  embed-url.ts       writes the URL that reproduces what's on screen
  persistence.ts     one switch for reading/writing localStorage
```

## Debugging

In development, `window.engine` exposes `camera`, `settings`, `scene`,
`world`, `lights`, `menu`, `rasterizer`, `presenter`, `capture(scale)`,
`getUiFramebuffer()`, `getUiViewport()`,
`dumpGlyphs()`, `countByColor()`, `showCharset()`, `setOverlay(fn)`, and
`step()`.

`dumpGlyphs` and `countByColor` answer what the GPU can't: which character
is actually in that cell, and which layer went missing. `showCharset`
covers the scene with all 256 glyphs and checks the atlas against the data
textures.

`step()` draws a single frame on demand. In a background tab
`requestAnimationFrame` doesn't fire, and without it any check of "I
changed a setting, what happened?" measures the previous frame and
concludes nothing changed.

