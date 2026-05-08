const productButtons = document.getElementById("productButtons");
const statusBox = document.getElementById("statusBox");
const legendTitle = document.getElementById("legendTitle");
const legendBar = document.querySelector(".legend-bar");
const legendMin = document.getElementById("legendMin");
const legendMax = document.getElementById("legendMax");
const opacitySlider = document.getElementById("opacitySlider");
const opacityValue = document.getElementById("opacityValue");

let map;
let reflectivityLayer;
let mapReadyPromise;
let appConfig;
let loadSequence = 0;
let frameHistory = [];
let hoverPopup;
let currentProductId = "";
let currentFrameSourceUrl = "";
let currentOpacity = 0.82;

function isTypingTarget(target) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable
  );
}

function currentSourceUrl() {
  return currentFrameSourceUrl || appConfig?.defaultSourceUrl || "";
}

function currentProduct() {
  return appConfig?.products?.find((product) => product.id === currentProductId) || appConfig?.products?.[0] || null;
}

function updateOpacityLabel(opacity) {
  if (opacityValue) {
    opacityValue.textContent = `${Math.round(opacity * 100)}%`;
  }
}

function setLayerOpacity(opacity) {
  currentOpacity = opacity;
  updateOpacityLabel(opacity);
  if (reflectivityLayer) {
    reflectivityLayer.setOpacity(opacity);
  }
}

function initOpacityControl() {
  if (!opacitySlider) {
    return;
  }

  updateOpacityLabel(currentOpacity);
  opacitySlider.value = String(Math.round(currentOpacity * 100));
  opacitySlider.addEventListener("input", () => {
    const nextOpacity = Number(opacitySlider.value) / 100;
    setLayerOpacity(Number.isFinite(nextOpacity) ? nextOpacity : currentOpacity);
  });
}

function renderProductButtons() {
  if (!productButtons || !appConfig?.products?.length) {
    return;
  }

  productButtons.innerHTML = appConfig.products
    .map((product) => {
      const activeClass = product.id === currentProductId ? " is-active" : "";
      return `<button type="button" class="product-button${activeClass}" data-product-id="${product.id}">${product.label}</button>`;
    })
    .join("");

  for (const button of productButtons.querySelectorAll(".product-button")) {
    button.addEventListener("click", () => {
      const nextProductId = button.getAttribute("data-product-id") || "";
      if (!nextProductId || nextProductId === currentProductId) {
        return;
      }

      currentProductId = nextProductId;
      currentFrameSourceUrl = currentProduct()?.sourceUrl || "";
      renderProductButtons();
      void refreshLatestFrame();
    });
  }
}

function setLegendPalette(palette) {
  if (!legendBar || !legendTitle || !palette) {
    return;
  }

  legendTitle.textContent = palette.label || "Scale";
  legendBar.style.background = `linear-gradient(90deg, ${palette.colors.join(", ")})`;
}

function paletteStops(palette) {
  return Array.isArray(palette?.values) ? palette.values : [];
}

function formatValue(value, units) {
  if (units === "in") {
    return value.toFixed(value < 1 ? 2 : 1);
  }

  return value.toFixed(1);
}

async function refreshLatestFrame() {
  try {
    await refreshFrameHistory({ forceLatest: true });
    await loadDataset();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

async function fetchFrameHistory(sourceUrl) {
  const response = await fetch(`/api/reflectivity/history?source=${encodeURIComponent(sourceUrl)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "History request failed.");
  }

  return payload.frames || [];
}

async function refreshFrameHistory({ forceLatest = false } = {}) {
  const productSourceUrl = currentProduct()?.sourceUrl || appConfig.defaultSourceUrl;
  const seedSourceUrl = forceLatest ? productSourceUrl : currentSourceUrl() || productSourceUrl;
  frameHistory = await fetchFrameHistory(seedSourceUrl);

  const fallbackSource = forceLatest ? productSourceUrl : seedSourceUrl;
  currentFrameSourceUrl = frameHistory.some((entry) => entry.sourceUrl === fallbackSource)
    ? fallbackSource
    : (frameHistory[0]?.sourceUrl || fallbackSource);
}

async function fetchDataset(sourceUrl) {
  const metadataResponse = await fetch(`/api/reflectivity?source=${encodeURIComponent(sourceUrl)}`);
  const metadata = await metadataResponse.json();
  if (!metadataResponse.ok) {
    throw new Error(metadata.error || "Metadata request failed.");
  }

  const textureResponse = await fetch(metadata.textureUrl);
  if (!textureResponse.ok) {
    throw new Error("Texture request failed.");
  }

  const textureBytes = new Uint8Array(await textureResponse.arrayBuffer());
  return { metadata, textureBytes };
}

async function loadConfig() {
  if (appConfig) {
    return appConfig;
  }

  const response = await fetch("/api/config");
  appConfig = await response.json();
  if (!response.ok) {
    throw new Error("Failed to load app config.");
  }

  frameHistory = appConfig.history || [];
  currentProductId = appConfig.defaultProductId;
  currentFrameSourceUrl = appConfig.defaultSourceUrl;
  renderProductButtons();
  return appConfig;
}

function setStatus(message) {
  if (statusBox) {
    statusBox.textContent = message;
  }
}

function setMetadata(metadata) {
  setLegendPalette(metadata.palette);
  const stops = paletteStops(metadata.palette);
  const legendMinValue = stops.length ? stops[0] : metadata.encoding.valueRange.displayMin;
  const legendMaxValue = stops.length ? stops[stops.length - 1] : metadata.encoding.valueRange.displayMax;
  legendMin.textContent = formatValue(legendMinValue, metadata.units);
  legendMax.textContent = formatValue(legendMaxValue, metadata.units);
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed.");
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Program link failed.");
  }
  return program;
}

class ReflectivityLayer {
  constructor(id) {
    this.id = id;
    this.type = "custom";
    this.renderingMode = "2d";
    this.map = null;
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.texture = null;
    this.vertexCount = 0;
    this.pendingTexture = null;
    this.pendingMetadata = null;
  }

  normalizeLongitude(lng, west, east) {
    let normalizedLng = lng;

    while (normalizedLng < west) {
      normalizedLng += 360;
    }

    while (normalizedLng > east) {
      normalizedLng -= 360;
    }

    return normalizedLng;
  }

  getValueAtLngLat(lng, lat) {
    if (!this.pendingMetadata || !this.pendingTexture) {
      return null;
    }

    const { bounds, width, height, encoding, units } = this.pendingMetadata;
    const normalizedLng = this.normalizeLongitude(lng, bounds.west, bounds.east);
    const lonSpan = bounds.east - bounds.west;
    const latSpan = bounds.north - bounds.south;

    if (
      normalizedLng < bounds.west ||
      normalizedLng > bounds.east ||
      lat < bounds.south ||
      lat > bounds.north ||
      lonSpan <= 0 ||
      latSpan <= 0
    ) {
      return null;
    }

    const u = Math.min(Math.max((normalizedLng - bounds.west) / lonSpan, 0), 1);
    const v = Math.min(Math.max((lat - bounds.south) / latSpan, 0), 1);
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor(v * height));
    const encoded = this.pendingTexture[(y * width) + x];

    if (!encoded) {
      return null;
    }

    const { dataMin, dataMax } = encoding.valueRange;
    const value = dataMin + ((encoded - 1) / 254) * (dataMax - dataMin);

    return {
      value,
      units,
      lng: normalizedLng,
      lat,
    };
  }

  onAdd(mapInstance, gl) {
    this.map = mapInstance;
    this.gl = gl;
    this.program = createProgram(
      gl,
      `
      precision highp float;
      uniform mat4 uMatrix;
      attribute vec2 aPosition;
      varying vec2 vMercatorCoord;

      void main() {
        vMercatorCoord = aPosition;
        gl_Position = uMatrix * vec4(aPosition, 0.0, 1.0);
      }
      `,
      `
      precision highp float;
      uniform sampler2D uTexture;
      uniform int uPaletteMode;
      uniform float uOpacity;
      uniform float uDataMin;
      uniform float uDataMax;
      uniform float uPaletteStops[12];
      uniform float uWest;
      uniform float uEast;
      uniform float uSouth;
      uniform float uNorth;
      varying vec2 vMercatorCoord;

      const float PI = 3.141592653589793;
      const int PALETTE_SIZE = 12;

      vec3 reflectivityPalette(float t) {
        vec3 c0 = vec3(0.714, 1.000, 0.714);
        vec3 c1 = vec3(0.329, 0.953, 0.329);
        vec3 c2 = vec3(0.098, 0.639, 0.098);
        vec3 c3 = vec3(0.004, 0.400, 0.004);
        vec3 c4 = vec3(0.788, 0.788, 0.220);
        vec3 c5 = vec3(0.961, 0.973, 0.145);
        vec3 c6 = vec3(1.000, 0.843, 0.000);
        vec3 c7 = vec3(1.000, 0.647, 0.000);
        vec3 c8 = vec3(1.000, 0.498, 0.314);
        vec3 c9 = vec3(1.000, 0.271, 0.000);
        vec3 c10 = vec3(1.000, 0.078, 0.576);
        vec3 c11 = vec3(0.580, 0.000, 0.827);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 qpePalette(float t) {
        vec3 c0 = vec3(0.969, 0.984, 1.000);
        vec3 c1 = vec3(0.871, 0.922, 0.969);
        vec3 c2 = vec3(0.776, 0.859, 0.937);
        vec3 c3 = vec3(0.620, 0.792, 0.882);
        vec3 c4 = vec3(0.420, 0.682, 0.839);
        vec3 c5 = vec3(0.259, 0.573, 0.776);
        vec3 c6 = vec3(0.129, 0.443, 0.710);
        vec3 c7 = vec3(0.031, 0.318, 0.612);
        vec3 c8 = vec3(1.000, 1.000, 0.698);
        vec3 c9 = vec3(0.996, 0.800, 0.361);
        vec3 c10 = vec3(0.992, 0.553, 0.235);
        vec3 c11 = vec3(0.890, 0.102, 0.110);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 lightningPalette(float t) {
        vec3 c0 = vec3(0.078, 0.043, 0.204);
        vec3 c1 = vec3(0.165, 0.114, 0.447);
        vec3 c2 = vec3(0.122, 0.302, 0.722);
        vec3 c3 = vec3(0.082, 0.557, 0.910);
        vec3 c4 = vec3(0.067, 0.773, 0.961);
        vec3 c5 = vec3(0.275, 0.941, 0.776);
        vec3 c6 = vec3(0.561, 1.000, 0.478);
        vec3 c7 = vec3(0.949, 1.000, 0.357);
        vec3 c8 = vec3(1.000, 0.749, 0.220);
        vec3 c9 = vec3(1.000, 0.482, 0.133);
        vec3 c10 = vec3(1.000, 0.239, 0.180);
        vec3 c11 = vec3(1.000, 0.953, 0.941);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 temperaturePalette(float t) {
        vec3 c0 = vec3(0.227, 0.110, 0.443);
        vec3 c1 = vec3(0.129, 0.333, 0.773);
        vec3 c2 = vec3(0.184, 0.525, 1.000);
        vec3 c3 = vec3(0.412, 0.776, 1.000);
        vec3 c4 = vec3(0.718, 0.953, 1.000);
        vec3 c5 = vec3(0.957, 0.969, 0.824);
        vec3 c6 = vec3(1.000, 0.878, 0.541);
        vec3 c7 = vec3(1.000, 0.702, 0.302);
        vec3 c8 = vec3(1.000, 0.482, 0.227);
        vec3 c9 = vec3(0.937, 0.302, 0.235);
        vec3 c10 = vec3(0.788, 0.176, 0.294);
        vec3 c11 = vec3(0.420, 0.114, 0.227);

        if (t < 0.0909) {
          return mix(c0, c1, t / 0.0909);
        }
        if (t < 0.1818) {
          return mix(c1, c2, (t - 0.0909) / 0.0909);
        }
        if (t < 0.2727) {
          return mix(c2, c3, (t - 0.1818) / 0.0909);
        }
        if (t < 0.3636) {
          return mix(c3, c4, (t - 0.2727) / 0.0909);
        }
        if (t < 0.4545) {
          return mix(c4, c5, (t - 0.3636) / 0.0909);
        }
        if (t < 0.5454) {
          return mix(c5, c6, (t - 0.4545) / 0.0909);
        }
        if (t < 0.6363) {
          return mix(c6, c7, (t - 0.5454) / 0.0909);
        }
        if (t < 0.7272) {
          return mix(c7, c8, (t - 0.6363) / 0.0909);
        }
        if (t < 0.8181) {
          return mix(c8, c9, (t - 0.7272) / 0.0909);
        }
        if (t < 0.9090) {
          return mix(c9, c10, (t - 0.8181) / 0.0909);
        }
        return mix(c10, c11, (t - 0.9090) / 0.0910);
      }

      vec3 palette(float t) {
        if (uPaletteMode == 1) {
          return qpePalette(t);
        }

        if (uPaletteMode == 2) {
          return lightningPalette(t);
        }

        if (uPaletteMode == 3) {
          return temperaturePalette(t);
        }

        return reflectivityPalette(t);
      }

      float valueToPaletteT(float value) {
        if (value <= uPaletteStops[0]) {
          return 0.0;
        }

        for (int i = 0; i < PALETTE_SIZE - 1; i += 1) {
          float lower = uPaletteStops[i];
          float upper = uPaletteStops[i + 1];
          if (value <= upper) {
            float segmentT = (value - lower) / max(upper - lower, 0.0001);
            return (float(i) + segmentT) / float(PALETTE_SIZE - 1);
          }
        }

        return 1.0;
      }

      float mercatorYToLatitude(float y) {
        float mercator = PI * (1.0 - 2.0 * y);
        float sinhMercator = 0.5 * (exp(mercator) - exp(-mercator));
        return degrees(atan(sinhMercator));
      }

      void main() {
        float lng = vMercatorCoord.x * 360.0 - 180.0;
        float lat = mercatorYToLatitude(vMercatorCoord.y);
        float u = (lng - uWest) / max(uEast - uWest, 0.000001);
        float v = (lat - uSouth) / max(uNorth - uSouth, 0.000001);
        vec2 uv = vec2(clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0));
        vec4 texel = texture2D(uTexture, uv);
        float encoded = floor(texel.r * 255.0 + 0.5);
        if (encoded < 0.5) {
          discard;
        }

        float value = mix(uDataMin, uDataMax, (encoded - 1.0) / 254.0);
        float t = valueToPaletteT(value);
        float alpha = smoothstep(0.02, 0.12, t) * uOpacity;
        gl_FragColor = vec4(palette(t), alpha);
      }
      `,
    );

    this.buffer = gl.createBuffer();
    this.texture = gl.createTexture();

    if (this.pendingMetadata && this.pendingTexture) {
      this.applyDataset(this.pendingMetadata, this.pendingTexture);
    }
  }

  setDataset(metadata, textureBytes) {
    this.pendingMetadata = metadata;
    this.pendingTexture = textureBytes;

    if (this.gl) {
      this.applyDataset(metadata, textureBytes);
      this.map.triggerRepaint();
    }
  }

  setOpacity(opacity) {
    this.opacity = opacity;
    if (this.map) {
      this.map.triggerRepaint();
    }
  }

  applyDataset(metadata, textureBytes) {
    const gl = this.gl;
    const bounds = metadata.mercatorBounds;
    const expectedBytes = metadata.width * metadata.height;
    if (textureBytes.byteLength !== expectedBytes) {
      throw new Error(
        `Texture byte length mismatch. Expected ${expectedBytes} bytes, received ${textureBytes.byteLength}.`,
      );
    }

    const sw = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.west, lat: bounds.south });
    const nw = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.west, lat: bounds.north });
    const se = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.east, lat: bounds.south });
    const ne = mapboxgl.MercatorCoordinate.fromLngLat({ lng: bounds.east, lat: bounds.north });

    const vertices = new Float32Array([
      sw.x, sw.y, 0, 0,
      nw.x, nw.y, 0, 1,
      se.x, se.y, 1, 0,
      se.x, se.y, 1, 0,
      nw.x, nw.y, 0, 1,
      ne.x, ne.y, 1, 1,
    ]);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.vertexCount = 6;

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      metadata.width,
      metadata.height,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      textureBytes,
    );
  }

  render(gl, matrix) {
    if (!this.pendingMetadata || !this.texture || this.vertexCount === 0) {
      return;
    }

    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const positionLocation = gl.getAttribLocation(this.program, "aPosition");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, stride, 0);

    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, "uMatrix"), false, matrix);
    gl.uniform1f(gl.getUniformLocation(this.program, "uOpacity"), this.opacity ?? currentOpacity);
    gl.uniform1f(gl.getUniformLocation(this.program, "uDataMin"), this.pendingMetadata.encoding.valueRange.dataMin);
    gl.uniform1f(gl.getUniformLocation(this.program, "uDataMax"), this.pendingMetadata.encoding.valueRange.dataMax);
    gl.uniform1fv(
      gl.getUniformLocation(this.program, "uPaletteStops"),
      new Float32Array(paletteStops(this.pendingMetadata.palette)),
    );
    gl.uniform1i(
      gl.getUniformLocation(this.program, "uPaletteMode"),
      this.pendingMetadata.palette.kind === "qpe"
        ? 1
        : this.pendingMetadata.palette.kind === "lightning"
          ? 2
          : this.pendingMetadata.palette.kind === "temperature"
            ? 3
            : 0,
    );
    gl.uniform1f(gl.getUniformLocation(this.program, "uWest"), this.pendingMetadata.bounds.west);
    gl.uniform1f(gl.getUniformLocation(this.program, "uEast"), this.pendingMetadata.bounds.east);
    gl.uniform1f(gl.getUniformLocation(this.program, "uSouth"), this.pendingMetadata.bounds.south);
    gl.uniform1f(gl.getUniformLocation(this.program, "uNorth"), this.pendingMetadata.bounds.north);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(gl.getUniformLocation(this.program, "uTexture"), 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);
  }
}

function initMap(token) {
  if (mapReadyPromise) {
    return mapReadyPromise;
  }

  mapboxgl.accessToken = token;
  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: [-96, 38],
    zoom: 3,
    projection: "mercator",
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");
  mapReadyPromise = new Promise((resolve) => {
    map.on("load", () => {
      reflectivityLayer = new ReflectivityLayer("reflectivity-layer");
      reflectivityLayer.setOpacity(currentOpacity);
      map.addLayer(reflectivityLayer);

      hoverPopup = new mapboxgl.Popup({
        closeButton: false,
        closeOnClick: false,
        className: "hover-value-popup",
        offset: 12,
      });

      map.on("mousemove", (event) => {
        const hoverValue = reflectivityLayer.getValueAtLngLat(event.lngLat.lng, event.lngLat.lat);

        if (!hoverValue) {
          map.getCanvas().style.cursor = "";
          hoverPopup.remove();
          return;
        }

        map.getCanvas().style.cursor = "crosshair";
        hoverPopup
          .setLngLat(event.lngLat)
          .setHTML(`<strong>${formatValue(hoverValue.value, hoverValue.units)} ${hoverValue.units}</strong>`)
          .addTo(map);
      });

      map.on("mouseout", () => {
        map.getCanvas().style.cursor = "";
        hoverPopup.remove();
      });

      setStatus("Map ready. Loading the latest MRMS product.");
      resolve();
    });
  });

  return mapReadyPromise;
}

initOpacityControl();

async function loadDataset() {
  await loadConfig();
  const token = (appConfig.defaultMapboxToken || "").trim();
  if (!token) {
    setStatus("No Mapbox token is configured on the backend.");
    return;
  }

  const currentLoad = ++loadSequence;

  if (!map) {
    await initMap(token);
  } else if (mapReadyPromise) {
    await mapReadyPromise;
  }

  const sourceUrl = currentSourceUrl();
  const selectedFrame = frameHistory.find((entry) => entry.sourceUrl === sourceUrl);
  const frameLabel = selectedFrame?.label || "selected";
  const productLabel = currentProduct()?.label || "MRMS product";
  setStatus(`Building ${productLabel} frame ${frameLabel} from GRIB2. This can take a bit on the first request.`);

  const { metadata, textureBytes } = await fetchDataset(sourceUrl);
  if (currentLoad !== loadSequence) {
    return;
  }

  setMetadata(metadata);
  reflectivityLayer.setDataset(metadata, textureBytes);

  const bounds = metadata.mercatorBounds;
  map.fitBounds(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    { padding: 40, duration: 0 },
  );

  setStatus(`Rendered ${metadata.productLabel || productLabel} frame ${frameLabel} through the custom WebGL layer.`);
}

loadConfig()
  .then(() => {
    if ((appConfig.defaultMapboxToken || "").trim()) {
      return initMap(appConfig.defaultMapboxToken.trim());
    }

    setStatus("Configure a Mapbox token in the backend to initialize the map.");
    return null;
  })
  .then(() => refreshFrameHistory({ forceLatest: false }))
  .then(() => refreshLatestFrame())
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error));
  });