/* Живой фон: симуляция жидкости на WebGL (уравнения Навье — Стокса).
   Перенесено из Desktop/07-shader: адвекция, давление, завихрённость, bloom,
   звёздное небо и хроматическая аберрация. Курсор и горячие клавиши не трогаем:
   фон только реагирует на движение мыши и клики по пустому месту. */
(function () {
'use strict';

const canvas = document.getElementById('fluid');
if (!canvas) return;

const config = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 720,
  DENSITY_DISSIPATION: 1.1,
  VELOCITY_DISSIPATION: 0.25,
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 20,
  CURL: 26,
  SPLAT_RADIUS: 0.25,
  SPLAT_FORCE: 6000,
  SHADING: true,
  BLOOM: true,
  BLOOM_ITERATIONS: 8,
  BLOOM_RESOLUTION: 256,
  BLOOM_INTENSITY: 0.55,
  BLOOM_THRESHOLD: 0.6,
  BLOOM_SOFT_KNEE: 0.7,
  ABERRATION: true
};
const QUALITY = [
  { dye: 1024, sim: 144 },
  { dye: 720, sim: 128 },
  { dye: 512, sim: 96 },
  { dye: 384, sim: 64 }
];
let qualityIndex = 1;

/* Палитра в цветах интерфейса: фиолетовый → маджента → бирюзовый (как в 01-landing). */
const STOPS = [[0.42, 0.36, 1.0], [1.0, 0.31, 0.80], [0.26, 0.94, 0.82], [0.55, 0.45, 1.0]];
const TINT = [0.016, 0.014, 0.048];
function paletteColor (t) {
  t = ((t % 1) + 1) % 1;
  const seg = t * (STOPS.length - 1);
  const i = Math.floor(seg), f = seg - i;
  const a = STOPS[i], b = STOPS[Math.min(i + 1, STOPS.length - 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
function scaleColor (c, s) { return [c[0] * s, c[1] * s, c[2] * s]; }

/* ---------------------- шейдеры (GLSL ES 1.00) ---------------------- */
const baseVertexSource = `
precision highp float;
attribute vec2 aPosition;
varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
uniform vec2 texelSize;
void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
}`;
const copySource = `
precision mediump float; precision mediump sampler2D;
varying highp vec2 vUv; uniform sampler2D uTexture;
void main () { gl_FragColor = texture2D(uTexture, vUv); }`;
const clearSource = `
precision mediump float; precision mediump sampler2D;
varying highp vec2 vUv; uniform sampler2D uTexture; uniform float value;
void main () { gl_FragColor = value * texture2D(uTexture, vUv); }`;
const splatSource = `
precision highp float; precision highp sampler2D;
varying vec2 vUv; uniform sampler2D uTarget; uniform float aspectRatio;
uniform vec3 color; uniform vec2 point; uniform float radius;
void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
}`;
const advectionSource = `
precision highp float; precision highp sampler2D;
varying vec2 vUv;
uniform sampler2D uVelocity; uniform sampler2D uSource;
uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;
vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
    vec2 st = uv / tsize - 0.5;
    vec2 iuv = floor(st); vec2 fuv = fract(st);
    vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
    vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
    vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
    vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}
void main () {
#ifdef MANUAL_FILTERING
    vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
    vec4 result = bilerp(uSource, coord, dyeTexelSize);
#else
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 result = texture2D(uSource, coord);
#endif
    float decay = 1.0 + dissipation * dt;
    gl_FragColor = result / decay;
}`;
const divergenceSource = `
precision mediump float; precision mediump sampler2D;
varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
uniform sampler2D uVelocity;
void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}`;
const curlSource = `
precision mediump float; precision mediump sampler2D;
varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
uniform sampler2D uVelocity;
void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    gl_FragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;
const vorticitySource = `
precision highp float; precision highp sampler2D;
varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;
const pressureSource = `
precision mediump float; precision mediump sampler2D;
varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
uniform sampler2D uPressure; uniform sampler2D uDivergence;
void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    gl_FragColor = vec4((L + R + B + T - divergence) * 0.25, 0.0, 0.0, 1.0);
}`;
const gradientSubtractSource = `
precision mediump float; precision mediump sampler2D;
varying highp vec2 vUv; varying highp vec2 vL; varying highp vec2 vR; varying highp vec2 vT; varying highp vec2 vB;
uniform sampler2D uPressure; uniform sampler2D uVelocity;
void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
}`;
const bloomPrefilterSource = `
precision mediump float; precision mediump sampler2D;
varying vec2 vUv; uniform sampler2D uTexture; uniform vec3 curve; uniform float threshold;
void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - curve.x, 0.0, curve.y);
    rq = curve.z * rq * rq;
    c *= max(rq, br - threshold) / max(br, 0.0001);
    gl_FragColor = vec4(c, 0.0);
}`;
const bloomBlurSource = `
precision mediump float; precision mediump sampler2D;
varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uTexture;
void main () {
    vec4 sum = texture2D(uTexture, vL) + texture2D(uTexture, vR) + texture2D(uTexture, vT) + texture2D(uTexture, vB);
    gl_FragColor = sum * 0.25;
}`;
const bloomFinalSource = `
precision mediump float; precision mediump sampler2D;
varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB; uniform sampler2D uTexture; uniform float intensity;
void main () {
    vec4 sum = texture2D(uTexture, vL) + texture2D(uTexture, vR) + texture2D(uTexture, vT) + texture2D(uTexture, vB);
    gl_FragColor = sum * 0.25 * intensity;
}`;
const displaySource = `
precision highp float; precision highp sampler2D;
varying vec2 vUv; varying vec2 vL; varying vec2 vR; varying vec2 vT; varying vec2 vB;
uniform sampler2D uTexture; uniform sampler2D uBloom; uniform vec2 texelSize;
uniform float uTime; uniform float uAspect; uniform vec3 uTint; uniform float uCA;
float hash12 (vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float starLayer (vec2 uv, float t) {
    vec2 id = floor(uv);
    vec2 f = fract(uv) - 0.5;
    float h = hash12(id);
    vec2 off = vec2(hash12(id + 17.31), hash12(id + 47.77)) - 0.5;
    float d = length(f - off * 0.7);
    float star = smoothstep(0.10, 0.0, d);
    float tw = 0.6 + 0.4 * sin(t * (0.8 + h * 2.5) + h * 41.0);
    return star * tw * step(0.80, h) * (h - 0.80) * 5.0;
}
vec3 linearToGamma (vec3 color) {
    color = max(color, vec3(0.0));
    return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0.0));
}
void main () {
    vec2 dir = vUv - vec2(0.5);
    float r2 = dot(dir, dir);
    vec2 caOff = dir * (uCA * 0.014 * r2);
    vec3 c;
    c.r = texture2D(uTexture, vUv + caOff).r;
    c.g = texture2D(uTexture, vUv).g;
    c.b = texture2D(uTexture, vUv - caOff).b;
#ifdef SHADING
    vec3 lc = texture2D(uTexture, vL).rgb;
    vec3 rc = texture2D(uTexture, vR).rgb;
    vec3 tc = texture2D(uTexture, vT).rgb;
    vec3 bc = texture2D(uTexture, vB).rgb;
    float dx = length(rc) - length(lc);
    float dy = length(tc) - length(bc);
    vec3 n = normalize(vec3(dx, dy, length(texelSize)));
    float diffuse = clamp(dot(n, vec3(0.0, 0.0, 1.0)) + 0.7, 0.7, 1.0);
    c *= diffuse;
#endif
#ifdef BLOOM
    c += linearToGamma(texture2D(uBloom, vUv).rgb);
#endif
    float lum = max(c.r, max(c.g, c.b));
    vec2 suv = vec2(vUv.x * uAspect, vUv.y);
    float stars = starLayer(suv * 21.0, uTime);
    stars += starLayer(suv * 43.0 + 7.31, uTime * 1.37) * 0.55;
    vec3 bg = uTint * (1.45 - smoothstep(0.0, 0.55, r2));
    bg += vec3(0.75, 0.85, 1.0) * (stars * 0.55);
    c += bg * smoothstep(0.45, 0.0, lum);
    c *= 1.0 - 0.38 * smoothstep(0.12, 0.62, r2);
    c += vec3(hash12(gl_FragCoord.xy + vec2(fract(uTime) * 61.7)) - 0.5) / 255.0;
    gl_FragColor = vec4(c, 1.0);
}`;

/* ------------------------ WebGL ------------------------ */
let gl = null, ext = null, bloomAvailable = true, rafId = 0, running = false, paused = false;

function scaleByPixelRatio (v) { return Math.floor(v * Math.min(window.devicePixelRatio || 1, 1.5)); }
function resizeCanvas () {
  const w = scaleByPixelRatio(canvas.clientWidth || window.innerWidth);
  const h = scaleByPixelRatio(canvas.clientHeight || window.innerHeight);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
  return false;
}

function supportRenderTextureFormat (g, internalFormat, format, type) {
  const texture = g.createTexture();
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, texture);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  g.texImage2D(g.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);
  const fbo = g.createFramebuffer();
  g.bindFramebuffer(g.FRAMEBUFFER, fbo);
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, texture, 0);
  const ok = g.checkFramebufferStatus(g.FRAMEBUFFER) === g.FRAMEBUFFER_COMPLETE;
  g.bindFramebuffer(g.FRAMEBUFFER, null);
  g.deleteFramebuffer(fbo);
  g.deleteTexture(texture);
  return ok;
}

function getWebGLContext () {
  const params = { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, powerPreference: 'default' };
  let g = canvas.getContext('webgl2', params);
  const isWebGL2 = !!g;
  if (!isWebGL2) g = canvas.getContext('webgl', params) || canvas.getContext('experimental-webgl', params);
  if (!g) return null;
  if (isWebGL2) { g.getExtension('EXT_color_buffer_float'); g.getExtension('EXT_color_buffer_half_float'); }

  function formatsFor (type) {
    let rgba, rg, r;
    if (isWebGL2) {
      const half = type === g.HALF_FLOAT;
      const RGBA_IF = half ? g.RGBA16F : g.RGBA32F, RG_IF = half ? g.RG16F : g.RG32F, R_IF = half ? g.R16F : g.R32F;
      rgba = supportRenderTextureFormat(g, RGBA_IF, g.RGBA, type) ? { internalFormat: RGBA_IF, format: g.RGBA } : null;
      if (!rgba) return null;
      rg = supportRenderTextureFormat(g, RG_IF, g.RG, type) ? { internalFormat: RG_IF, format: g.RG } : rgba;
      r = supportRenderTextureFormat(g, R_IF, g.RED, type) ? { internalFormat: R_IF, format: g.RED } : rgba;
    } else {
      rgba = supportRenderTextureFormat(g, g.RGBA, g.RGBA, type) ? { internalFormat: g.RGBA, format: g.RGBA } : null;
      if (!rgba) return null;
      rg = r = rgba;
    }
    return { rgba: rgba, rg: rg, r: r };
  }

  let texType = null, fmts = null, linear = false;
  if (isWebGL2) {
    fmts = formatsFor(g.HALF_FLOAT);
    if (fmts) { texType = g.HALF_FLOAT; linear = true; }
    else {
      fmts = formatsFor(g.FLOAT);
      if (fmts) { texType = g.FLOAT; linear = !!g.getExtension('OES_texture_float_linear'); }
    }
  } else {
    const hf = g.getExtension('OES_texture_half_float');
    if (hf) {
      fmts = formatsFor(hf.HALF_FLOAT_OES);
      if (fmts) { texType = hf.HALF_FLOAT_OES; linear = !!g.getExtension('OES_texture_half_float_linear'); }
    }
    if (!fmts && g.getExtension('OES_texture_float')) {
      fmts = formatsFor(g.FLOAT);
      if (fmts) { texType = g.FLOAT; linear = !!g.getExtension('OES_texture_float_linear'); }
    }
  }
  if (!fmts) return null;
  g.clearColor(0, 0, 0, 1);
  return { gl: g, ext: { formatRGBA: fmts.rgba, formatRG: fmts.rg, formatR: fmts.r, halfFloatTexType: texType, supportLinearFiltering: linear } };
}

function compileShader (type, source, keywords) {
  if (keywords && keywords.length) source = keywords.map(function (k) { return '#define ' + k + '\n'; }).join('') + source;
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(shader));
  return shader;
}
function Program (vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPosition');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  this.program = p;
  this.uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    this.uniforms[name] = gl.getUniformLocation(p, name);
  }
}
Program.prototype.bind = function () { gl.useProgram(this.program); };

let blit = null;
function setupBlit () {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
  blit = function (target, clear) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    if (clear) { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };
}

let dye = null, velocity = null, divergence = null, curl = null, pressure = null, bloom = null, bloomFramebuffers = [];

function createFBO (w, h, internalFormat, format, type, param) {
  gl.activeTexture(gl.TEXTURE0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return {
    texture: texture, fbo: fbo, width: w, height: h, texelSizeX: 1 / w, texelSizeY: 1 / h,
    attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, texture); return id; }
  };
}
function destroyFBO (f) { if (f) { gl.deleteTexture(f.texture); gl.deleteFramebuffer(f.fbo); } }
function createDoubleFBO (w, h, internalFormat, format, type, param) {
  let a = createFBO(w, h, internalFormat, format, type, param);
  let b = createFBO(w, h, internalFormat, format, type, param);
  return {
    width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
    get read () { return a; }, set read (v) { a = v; },
    get write () { return b; }, set write (v) { b = v; },
    swap: function () { const t = a; a = b; b = t; }
  };
}
function destroyDoubleFBO (f) { if (f) { destroyFBO(f.read); destroyFBO(f.write); } }
function resizeFBO (target, w, h, internalFormat, format, type, param) {
  const n = createFBO(w, h, internalFormat, format, type, param);
  copyProgram.bind();
  gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
  blit(n);
  destroyFBO(target);
  return n;
}
function resizeDoubleFBO (target, w, h, internalFormat, format, type, param) {
  if (target.width === w && target.height === h) return target;
  target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
  destroyFBO(target.write);
  target.write = createFBO(w, h, internalFormat, format, type, param);
  target.width = w; target.height = h; target.texelSizeX = 1 / w; target.texelSizeY = 1 / h;
  return target;
}
function getResolution (resolution) {
  let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspect < 1) aspect = 1 / aspect;
  const min = Math.round(resolution), max = Math.round(resolution * aspect);
  return gl.drawingBufferWidth > gl.drawingBufferHeight ? { width: max, height: min } : { width: min, height: max };
}
function initFramebuffers () {
  const simRes = getResolution(config.SIM_RESOLUTION), dyeRes = getResolution(config.DYE_RESOLUTION);
  const t = ext.halfFloatTexType, rgba = ext.formatRGBA, rg = ext.formatRG, r = ext.formatR;
  const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;
  gl.disable(gl.BLEND);
  dye = dye == null ? createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, t, filtering)
    : resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, t, filtering);
  velocity = velocity == null ? createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, t, filtering)
    : resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, t, filtering);
  destroyFBO(divergence);
  divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, t, gl.NEAREST);
  destroyFBO(curl);
  curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, t, gl.NEAREST);
  destroyDoubleFBO(pressure);
  pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, t, gl.NEAREST);
  destroyFBO(bloom);
  bloom = null;
  bloomFramebuffers.forEach(destroyFBO);
  bloomFramebuffers = [];
  if (!bloomAvailable) return;
  const res = getResolution(config.BLOOM_RESOLUTION);
  bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, t, gl.LINEAR);
  for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
    const w = res.width >> (i + 1), h = res.height >> (i + 1);
    if (w < 2 || h < 2) break;
    bloomFramebuffers.push(createFBO(w, h, rgba.internalFormat, rgba.format, t, gl.LINEAR));
  }
}

let copyProgram, clearProgram, splatProgram, advectionProgram, divergenceProgram, curlProgram, vorticityProgram,
  pressureProgram, gradientSubtractProgram, bloomPrefilterProgram, bloomBlurProgram, bloomFinalProgram, displayProgram;

function compileAllPrograms () {
  setupBlit();
  const vs = compileShader(gl.VERTEX_SHADER, baseVertexSource);
  const fs = function (src, kw) { return compileShader(gl.FRAGMENT_SHADER, src, kw); };
  copyProgram = new Program(vs, fs(copySource));
  clearProgram = new Program(vs, fs(clearSource));
  splatProgram = new Program(vs, fs(splatSource));
  advectionProgram = new Program(vs, fs(advectionSource, ext.supportLinearFiltering ? null : ['MANUAL_FILTERING']));
  divergenceProgram = new Program(vs, fs(divergenceSource));
  curlProgram = new Program(vs, fs(curlSource));
  vorticityProgram = new Program(vs, fs(vorticitySource));
  pressureProgram = new Program(vs, fs(pressureSource));
  gradientSubtractProgram = new Program(vs, fs(gradientSubtractSource));
  bloomPrefilterProgram = new Program(vs, fs(bloomPrefilterSource));
  bloomBlurProgram = new Program(vs, fs(bloomBlurSource));
  bloomFinalProgram = new Program(vs, fs(bloomFinalSource));
  const kw = ['SHADING'];
  if (config.BLOOM) kw.push('BLOOM');
  displayProgram = new Program(vs, fs(displaySource, kw));
}

function step (dt) {
  gl.disable(gl.BLEND);
  curlProgram.bind();
  gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(curl);

  vorticityProgram.bind();
  gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
  gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
  gl.uniform1f(vorticityProgram.uniforms.dt, dt);
  blit(velocity.write);
  velocity.swap();

  divergenceProgram.bind();
  gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(divergence);

  clearProgram.bind();
  gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
  gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
  blit(pressure.write);
  pressure.swap();

  pressureProgram.bind();
  gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
  for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
    gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
    blit(pressure.write);
    pressure.swap();
  }

  gradientSubtractProgram.bind();
  gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
  gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
  blit(velocity.write);
  velocity.swap();

  advectionProgram.bind();
  gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
  const vid = velocity.read.attach(0);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, vid);
  gl.uniform1i(advectionProgram.uniforms.uSource, vid);
  gl.uniform1f(advectionProgram.uniforms.dt, dt);
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
  blit(velocity.write);
  velocity.swap();

  if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION);
  blit(dye.write);
  dye.swap();
}

function applyBloom (source, destination) {
  if (!destination || bloomFramebuffers.length < 2) return;
  let last = destination;
  gl.disable(gl.BLEND);
  bloomPrefilterProgram.bind();
  const knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
  gl.uniform3f(bloomPrefilterProgram.uniforms.curve, config.BLOOM_THRESHOLD - knee, knee * 2, 0.25 / knee);
  gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
  gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
  blit(last);
  bloomBlurProgram.bind();
  for (let i = 0; i < bloomFramebuffers.length; i++) {
    const dest = bloomFramebuffers[i];
    gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
    blit(dest);
    last = dest;
  }
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.enable(gl.BLEND);
  for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
    const base = bloomFramebuffers[i];
    gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
    blit(base);
    last = base;
  }
  gl.disable(gl.BLEND);
  bloomFinalProgram.bind();
  gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
  gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
  gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
  blit(destination);
}

function render () {
  if (config.BLOOM) applyBloom(dye.read, bloom);
  gl.disable(gl.BLEND);
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  displayProgram.bind();
  gl.uniform2f(displayProgram.uniforms.texelSize, 1 / w, 1 / h);
  gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
  if (config.BLOOM && bloom) gl.uniform1i(displayProgram.uniforms.uBloom, bloom.attach(1));
  gl.uniform1f(displayProgram.uniforms.uTime, simTime % 3600);
  gl.uniform1f(displayProgram.uniforms.uAspect, w / h);
  gl.uniform3f(displayProgram.uniforms.uTint, TINT[0], TINT[1], TINT[2]);
  gl.uniform1f(displayProgram.uniforms.uCA, config.ABERRATION ? 1 : 0);
  blit(null);
}

function correctRadius (radius) {
  const aspect = canvas.width / canvas.height;
  return aspect > 1 ? radius * aspect : radius;
}
function splat (x, y, dx, dy, color, radiusScale) {
  gl.disable(gl.BLEND);
  splatProgram.bind();
  gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
  gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(splatProgram.uniforms.point, x, y);
  gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0);
  gl.uniform1f(splatProgram.uniforms.radius, correctRadius(config.SPLAT_RADIUS / 100 * (radiusScale || 1)));
  blit(velocity.write);
  velocity.swap();
  gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
  gl.uniform3f(splatProgram.uniforms.color, color[0], color[1], color[2]);
  blit(dye.write);
  dye.swap();
}
function burst (x, y, power, count) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const speed = (500 + Math.random() * 700) * power;
    const col = scaleColor(paletteColor(Math.random() * 0.4 + simTime * 0.05 + 0.03 * i), 0.14 + Math.random() * 0.12);
    splat(x, y, Math.cos(a) * speed, Math.sin(a) * speed, col, 0.7 + Math.random() * 0.8);
  }
}
function introSplats () {
  for (let i = 0; i < 14; i++) {
    splat(0.15 + Math.random() * 0.7, 0.15 + Math.random() * 0.7,
      (Math.random() - 0.5) * 1600, (Math.random() - 0.5) * 1600,
      scaleColor(paletteColor(Math.random()), 0.18 + Math.random() * 0.22), 1 + Math.random());
  }
}

/* ---------------- «призраки»: фон живёт сам, пока мышь стоит ---------------- */
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let simTime = 0, lastInteraction = -10, idleK = 0;
const ghosts = [];
for (let i = 0; i < 3; i++) {
  ghosts.push({
    f1: 0.05 + Math.random() * 0.16, f2: 0.05 + Math.random() * 0.16, f3: 0.05 + Math.random() * 0.16, f4: 0.05 + Math.random() * 0.16,
    p1: Math.random() * 6.283, p2: Math.random() * 6.283, p3: Math.random() * 6.283, p4: Math.random() * 6.283,
    hue: Math.random(), x: 0.5, y: 0.5, hasPrev: false
  });
}
function updateGhosts (dt) {
  const target = simTime - lastInteraction < 2.5 ? 0 : 1;
  idleK += (target - idleK) * (1 - Math.exp(-dt * 1.5));
  for (const g of ghosts) {
    const t = simTime;
    const x = 0.5 + 0.36 * Math.sin(t * g.f1 + g.p1) * Math.cos(t * g.f2 + g.p2);
    const y = 0.5 + 0.34 * Math.sin(t * g.f3 + g.p3) * Math.cos(t * g.f4 + g.p4);
    if (g.hasPrev && idleK > 0.02) {
      const dx = x - g.x, dy = y - g.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.00001) {
        splat(x, y, dx * 9000 * idleK, dy * 9000 * idleK, scaleColor(paletteColor(t * 0.022 + g.hue), 0.08 * idleK), 0.55);
      }
    }
    g.x = x; g.y = y; g.hasPrev = true;
  }
}

/* ---------------- мышь и касания: курсор не меняем ---------------- */
const pointers = new Map();
function pointerFromEvent (e) {
  let p = pointers.get(e.pointerId);
  if (!p) { p = { x: 0.5, y: 0.5, px: 0.5, py: 0.5, moved: false, inited: false, seed: Math.random() }; pointers.set(e.pointerId, p); }
  const x = e.clientX / window.innerWidth, y = 1 - e.clientY / window.innerHeight;
  if (!p.inited) { p.px = x; p.py = y; p.inited = true; } else { p.px = p.x; p.py = p.y; }
  p.x = x; p.y = y;
  return p;
}
const INTERACTIVE = 'a, button, input, select, textarea, label, .card, .modal-content, .dd-panel, .navbar, .table, .toast';
window.addEventListener('pointermove', function (e) {
  if (e.pointerType !== 'mouse') return;   // на телефоне прокрутка не должна «размешивать» фон
  pointerFromEvent(e).moved = true;
  lastInteraction = simTime;
}, { passive: true });
window.addEventListener('pointerdown', function (e) {
  if (!running || (e.target.closest && e.target.closest(INTERACTIVE))) return;
  const p = pointerFromEvent(e);
  burst(p.x, p.y, 0.7, 8);
  lastInteraction = simTime;
}, { passive: true });
function applyPointerSplats () {
  pointers.forEach(function (p) {
    if (!p.moved) return;
    p.moved = false;
    const aspect = canvas.width / canvas.height;
    let dx = (p.x - p.px) * config.SPLAT_FORCE, dy = (p.y - p.py) * config.SPLAT_FORCE;
    if (aspect < 1) dx *= aspect; else dy /= aspect;
    splat(p.x, p.y, dx * 0.42, dy * 0.42, scaleColor(paletteColor(simTime * 0.10 + p.seed), 0.08), 0.62);
  });
}

/* ---------------- автокачество: слабый GPU не тормозит интерфейс ---------------- */
let perfEma = 16.7, perfWarmup = 120, perfLastDrop = 0;
function perfCheck (now, rawDt) {
  if (perfWarmup > 0) { perfWarmup--; return; }
  perfEma = perfEma * 0.95 + Math.min(rawDt * 1000, 100) * 0.05;
  if (perfEma > 30 && qualityIndex < QUALITY.length - 1 && now - perfLastDrop > 3000) {
    qualityIndex++;
    perfLastDrop = now;
    perfEma = 16.7;
    config.DYE_RESOLUTION = QUALITY[qualityIndex].dye;
    config.SIM_RESOLUTION = QUALITY[qualityIndex].sim;
    if (qualityIndex >= 2) { config.PRESSURE_ITERATIONS = 12; }
    initFramebuffers();
  }
}

let lastTime = performance.now(), frozenFrames = 0;
function frame (now) {
  if (paused) { running = false; return; }
  rafId = requestAnimationFrame(frame);
  let rawDt = (now - lastTime) / 1000;
  lastTime = now;
  if (!(rawDt >= 0)) rawDt = 0;
  const dt = Math.min(rawDt, 0.033);
  simTime += dt;
  if (resizeCanvas()) initFramebuffers();
  if (!reducedMotion) updateGhosts(dt);
  applyPointerSplats();
  step(dt);
  render();
  perfCheck(now, rawDt);
  // При «уменьшении движения» показываем неподвижную картинку.
  if (reducedMotion && ++frozenFrames > 90) { cancelAnimationFrame(rafId); running = false; }
}
function start () {
  if (running || paused || !gl) return;
  running = true;
  lastTime = performance.now();
  rafId = requestAnimationFrame(frame);
}

function fail () {
  document.documentElement.classList.add('no-webgl');
  canvas.style.display = 'none';
}

function boot () {
  try {
    const ctx = getWebGLContext();
    if (!ctx) { fail(); return; }
    gl = ctx.gl;
    ext = ctx.ext;
    bloomAvailable = ext.supportLinearFiltering;
    if (!bloomAvailable) config.BLOOM = false;
    if (window.innerWidth < 700) { qualityIndex = 2; config.DYE_RESOLUTION = 512; config.SIM_RESOLUTION = 96; }
    dye = velocity = divergence = curl = pressure = bloom = null;
    bloomFramebuffers = [];
    resizeCanvas();
    compileAllPrograms();
    initFramebuffers();
    introSplats();
    start();
  } catch (err) {
    fail();
  }
}

canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); cancelAnimationFrame(rafId); running = false; });
canvas.addEventListener('webglcontextrestored', boot);
document.addEventListener('visibilitychange', function () { if (!document.hidden) lastTime = performance.now(); });

// Своя картинка-фон в теме: симуляция ставится на паузу и не тратит видеокарту.
window.AkysayaFluid = {
  pause: function () { paused = true; cancelAnimationFrame(rafId); running = false; canvas.classList.add('is-paused'); },
  resume: function () { if (!paused) return; paused = false; canvas.classList.remove('is-paused'); start(); },
  ripple: function (x, y) { if (gl && running) burst(x, 1 - y, 0.9, 10); }
};
if (document.body.classList.contains('custom-bg-active')) {
  paused = true;
  canvas.classList.add('is-paused');
}
boot();
})();
