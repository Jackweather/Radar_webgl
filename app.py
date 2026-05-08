from __future__ import annotations

import gzip
import hashlib
import json
import math
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import numpy as np
import pygrib
import requests
from flask import Flask, Response, jsonify, request, send_from_directory


ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / ".cache"
SOURCE_DIR = CACHE_DIR / "sources"
DATASET_DIR = CACHE_DIR / "datasets"
DEFAULT_MAPBOX_TOKEN = "pk.eyJ1Ijoid2VhdGhlcmphY2sxODkiLCJhIjoiY21tYzN0MHVrMDI4djJxcHdzNXdpOTQ2MyJ9.IM4BBEnM5tNLI2SnEyl3uw"
MERCATOR_MAX_LAT = 85.05112878
MAX_RENDER_PIXELS = 4_000_000
CACHE_TTL_SECONDS = 300
CACHE_FORMAT_VERSION = "mrms-products-v6"
MRMS_HISTORY_LIMIT = 5
MM_TO_INCHES = 1.0 / 25.4
QPE_INCH_PALETTE = {
    "kind": "qpe",
    "label": "in",
    "values": [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0],
    "colors": [
        "#f7fbff",
        "#deebf7",
        "#c6dbef",
        "#9ecae1",
        "#6baed6",
        "#4292c6",
        "#2171b5",
        "#08519c",
        "#ffffb2",
        "#fecc5c",
        "#fd8d3c",
        "#e31a1c",
    ],
}
LIGHTNING_PALETTE = {
    "kind": "lightning",
    "label": "Lightning",
    "values": [0.0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0],
    "colors": [
        "#140b34",
        "#2a1d72",
        "#1f4db8",
        "#158ee8",
        "#11c5f5",
        "#46f0c6",
        "#8fff7a",
        "#f2ff5b",
        "#ffbf38",
        "#ff7b22",
        "#ff3d2e",
        "#fff3f0",
    ],
}
LIGHTNING_PROBABILITY_PALETTE = {
    "kind": "lightning",
    "label": "%",
    "values": [0.0, 5.0, 10.0, 15.0, 20.0, 30.0, 40.0, 50.0, 60.0, 75.0, 90.0, 100.0],
    "colors": LIGHTNING_PALETTE["colors"].copy(),
}
LIGHTNING_DENSITY_PALETTE = {
    "kind": "lightning",
    "label": "density",
    "values": [0.0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.75, 2.0],
    "colors": LIGHTNING_PALETTE["colors"].copy(),
}
TEMPERATURE_PALETTE = {
    "kind": "temperature",
    "label": "F",
    "values": [0.0, 10.0, 20.0, 32.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 110.0],
    "colors": [
        "#3a1c71",
        "#2155c5",
        "#2f86ff",
        "#69c6ff",
        "#b7f3ff",
        "#f4f7d2",
        "#ffe08a",
        "#ffb34d",
        "#ff7b3a",
        "#ef4d3c",
        "#c92d4b",
        "#6b1d3a",
    ],
}

PRODUCT_CONFIGS: dict[str, dict[str, Any]] = {
    "reflectivity": {
        "id": "reflectivity",
        "label": "Reflectivity",
        "legendTitle": "dBZ",
        "sourceUrl": (
            "https://mrms.ncep.noaa.gov/2D/ReflectivityAtLowestAltitude/"
            "MRMS_ReflectivityAtLowestAltitude.latest.grib2.gz"
        ),
        "historyPrefix": "MRMS_ReflectivityAtLowestAltitude",
        "messageTerms": ["reflect"],
        "minimumValue": -50.0,
        "unitsFallback": "dBZ",
        "palette": {
            "kind": "reflectivity",
            "label": "dBZ",
            "values": [0.0, 5.0, 10.0, 15.0, 20.0, 25.0, 30.0, 35.0, 40.0, 50.0, 60.0, 70.0],
            "colors": [
                "#b6ffb6",
                "#54f354",
                "#19a319",
                "#016601",
                "#c9c938",
                "#f5f825",
                "#ffd700",
                "#ffa500",
                "#ff7f50",
                "#ff4500",
                "#ff1493",
                "#9400d3",
            ],
        },
    },
    "qpe_1h": {
        "id": "qpe_1h",
        "label": "Radar-Only QPE 1H",
        "legendTitle": "1h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_01H/MRMS_RadarOnly_QPE_01H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_01H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "qpe_3h": {
        "id": "qpe_3h",
        "label": "Radar-Only QPE 3H",
        "legendTitle": "3h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_03H/MRMS_RadarOnly_QPE_03H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_03H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "qpe_6h": {
        "id": "qpe_6h",
        "label": "Radar-Only QPE 6H",
        "legendTitle": "6h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_06H/MRMS_RadarOnly_QPE_06H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_06H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "qpe_12h": {
        "id": "qpe_12h",
        "label": "Radar-Only QPE 12H",
        "legendTitle": "12h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_12H/MRMS_RadarOnly_QPE_12H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_12H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "qpe_24h": {
        "id": "qpe_24h",
        "label": "Radar-Only QPE 24H",
        "legendTitle": "24h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_24H/MRMS_RadarOnly_QPE_24H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_24H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "qpe_48h": {
        "id": "qpe_48h",
        "label": "Radar-Only QPE 48H",
        "legendTitle": "48h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_48H/MRMS_RadarOnly_QPE_48H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_48H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "qpe_72h": {
        "id": "qpe_72h",
        "label": "Radar-Only QPE 72H",
        "legendTitle": "72h QPE",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/RadarOnly_QPE_72H/MRMS_RadarOnly_QPE_72H.latest.grib2.gz",
        "historyPrefix": "MRMS_RadarOnly_QPE_72H",
        "messageTerms": ["qpe", "precip", "accum", "rain"],
        "minimumValue": 0.0,
        "unitsFallback": "in",
        "valueScale": MM_TO_INCHES,
        "palette": QPE_INCH_PALETTE.copy(),
    },
    "lightning": {
        "id": "lightning",
        "label": "Lightning Jump",
        "legendTitle": "Lightning",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/LtgJumpGrid/MRMS_LtgJumpGrid_scale_1.latest.grib2.gz",
        "historyPrefix": "MRMS_LtgJumpGrid_scale_1",
        "messageTerms": ["ltg", "lightning", "jump"],
        "minimumValue": 0.0,
        "unitsFallback": "index",
        "palette": LIGHTNING_PALETTE.copy(),
    },
    "lightning_probability_30m": {
        "id": "lightning_probability_30m",
        "label": "Lightning Prob 30m",
        "legendTitle": "Lightning %",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/LightningProbabilityNext30min/MRMS_LightningProbabilityNext30min.latest.grib2.gz",
        "historyPrefix": "MRMS_LightningProbabilityNext30min",
        "messageTerms": ["lightning", "prob", "probability"],
        "minimumValue": 0.0,
        "unitsFallback": "%",
        "palette": LIGHTNING_PROBABILITY_PALETTE.copy(),
    },
    "lightning_probability_60m": {
        "id": "lightning_probability_60m",
        "label": "Lightning Prob 60m",
        "legendTitle": "Lightning %",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/LightningProbabilityNext60min/MRMS_LightningProbabilityNext60min.latest.grib2.gz",
        "historyPrefix": "MRMS_LightningProbabilityNext60min",
        "messageTerms": ["lightning", "prob", "probability"],
        "minimumValue": 0.0,
        "unitsFallback": "%",
        "palette": LIGHTNING_PROBABILITY_PALETTE.copy(),
    },
    "lightning_max_5m": {
        "id": "lightning_max_5m",
        "label": "Lightning Max 5m",
        "legendTitle": "Lightning",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/LtgJumpGrid_Max_005min/MRMS_LtgJumpGrid_Max_005min.latest.grib2.gz",
        "historyPrefix": "MRMS_LtgJumpGrid_Max_005min",
        "messageTerms": ["ltg", "lightning", "jump"],
        "minimumValue": 0.0,
        "unitsFallback": "index",
        "palette": LIGHTNING_PALETTE.copy(),
    },
    "cloud_to_ground_lightning": {
        "id": "cloud_to_ground_lightning",
        "label": "CG Lightning",
        "legendTitle": "CG Density",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/NLDN_CG_001min_AvgDensity/MRMS_NLDN_CG_001min_AvgDensity.latest.grib2.gz",
        "historyPrefix": "MRMS_NLDN_CG_001min_AvgDensity",
        "messageTerms": ["cg", "lightning", "density"],
        "minimumValue": 0.0,
        "unitsFallback": "density",
        "palette": LIGHTNING_DENSITY_PALETTE.copy(),
    },
    "surface_temperature": {
        "id": "surface_temperature",
        "label": "Surface Temp",
        "legendTitle": "Surface Temp",
        "sourceUrl": "https://mrms.ncep.noaa.gov/2D/Model_SurfaceTemp/MRMS_Model_SurfaceTemp.latest.grib2.gz",
        "historyPrefix": "MRMS_Model_SurfaceTemp",
        "messageTerms": ["temp", "temperature", "surface"],
        "minimumValue": -100.0,
        "unitsFallback": "F",
        "valueScale": 9.0 / 5.0,
        "valueOffset": 32.0,
        "palette": TEMPERATURE_PALETTE.copy(),
    },
}
DEFAULT_PRODUCT_ID = "reflectivity"
DEFAULT_SOURCE_URL = PRODUCT_CONFIGS[DEFAULT_PRODUCT_ID]["sourceUrl"]


app = Flask(__name__, static_folder="static", static_url_path="/static")


def product_config_for_source(source_url: str) -> dict[str, Any]:
    filename = Path(urlparse(source_url).path).name
    for config in PRODUCT_CONFIGS.values():
        if filename.startswith(config["historyPrefix"]):
            return config

    return PRODUCT_CONFIGS[DEFAULT_PRODUCT_ID]


def product_payloads() -> list[dict[str, str]]:
    return [
        {
            "id": config["id"],
            "label": config["label"],
            "legendTitle": config["legendTitle"],
            "sourceUrl": config["sourceUrl"],
        }
        for config in PRODUCT_CONFIGS.values()
    ]


def ensure_cache_dirs() -> None:
    SOURCE_DIR.mkdir(parents=True, exist_ok=True)
    DATASET_DIR.mkdir(parents=True, exist_ok=True)


def dataset_key(source_url: str) -> str:
    seed = f"{CACHE_FORMAT_VERSION}:{source_url}"
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:16]


def cached_paths(key: str) -> dict[str, Path]:
    return {
        "source": SOURCE_DIR / f"{key}.grib2",
        "meta": DATASET_DIR / f"{key}.json",
        "texture": DATASET_DIR / f"{key}.luma.gz",
    }


def is_nomads_url(source_url: str) -> bool:
    parsed = urlparse(source_url)
    return parsed.scheme in {"http", "https"} and parsed.netloc.endswith("ncep.noaa.gov")


def latest_is_alias(source_url: str) -> bool:
    return source_url.endswith(".latest.grib2.gz")


def source_directory_url(source_url: str) -> str:
    return source_url.rsplit("/", 1)[0] + "/"


def list_recent_mrms_sources(source_url: str, limit: int = MRMS_HISTORY_LIMIT) -> list[dict[str, str]]:
    product_config = product_config_for_source(source_url)
    directory_url = source_directory_url(source_url)
    response = requests.get(directory_url, timeout=60)
    response.raise_for_status()

    pattern = re.compile(rf'href="({re.escape(product_config["historyPrefix"])}_[^"]+\.grib2\.gz)"')
    filenames = sorted(set(pattern.findall(response.text)), reverse=True)
    recent = filenames[:limit]
    return [
        {
            "label": "Latest",
            "sourceUrl": source_url,
            "kind": "latest",
        },
        *[
            {
                "label": filename.removesuffix(".grib2.gz").rsplit("_", 1)[-1],
                "sourceUrl": urljoin(directory_url, filename),
                "kind": "archive",
            }
            for filename in recent
        ],
    ]


def source_cache_is_fresh(source_url: str, source_path: Path) -> bool:
    if not source_path.exists() or source_path.stat().st_size == 0:
        return False

    if not latest_is_alias(source_url):
        return True

    return (time.time() - source_path.stat().st_mtime) <= CACHE_TTL_SECONDS


def download_grib(source_url: str, key: str) -> Path:
    output_path = cached_paths(key)["source"]
    if source_cache_is_fresh(source_url, output_path):
        return output_path

    suffix = ".grib2"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=output_path.parent) as handle:
        temp_path = Path(handle.name)

    with requests.get(source_url, stream=True, timeout=120) as response:
        response.raise_for_status()
        response.raw.decode_content = False
        with temp_path.open("wb") as handle:
            if source_url.endswith(".gz"):
                with gzip.GzipFile(fileobj=response.raw) as gz_stream:
                    shutil.copyfileobj(gz_stream, handle, length=1024 * 1024)
            else:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)

    temp_path.replace(output_path)
    return output_path


def pick_product_message(grib_file: pygrib.open, source_url: str) -> Any:
    product_config = product_config_for_source(source_url)
    message_terms = product_config["messageTerms"]
    messages = list(grib_file)

    if len(messages) == 1:
        return messages[0]

    for message in messages:
        fields = [
            getattr(message, "shortName", ""),
            getattr(message, "name", ""),
            getattr(message, "parameterName", ""),
        ]
        if any(term in str(field).lower() for field in fields for term in message_terms):
            return message

    return messages[0]


def normalize_longitudes(lon_row: np.ndarray, values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    shifted = ((lon_row + 180.0) % 360.0) - 180.0
    order = np.argsort(shifted)
    return shifted[order], values[:, order]


def compute_edge_bounds(lon_row: np.ndarray, lat_col: np.ndarray) -> tuple[float, float, float, float]:
    if lon_row.size < 2 or lat_col.size < 2:
        raise ValueError("Need at least two grid points to compute raster bounds.")

    lon_step = float(np.median(np.diff(lon_row)))
    lat_step = float(np.median(np.abs(np.diff(lat_col))))
    half_lon = lon_step / 2.0
    half_lat = lat_step / 2.0

    west = float(lon_row[0] - half_lon)
    east = float(lon_row[-1] + half_lon)
    south = float(lat_col[-1] - half_lat)
    north = float(lat_col[0] + half_lat)

    if east - west >= 359.5:
        west = -180.0
        east = 180.0

    return west, east, south, north


def downsample_grid(
    lon_row: np.ndarray,
    lat_col: np.ndarray,
    values: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    total_pixels = int(values.shape[0] * values.shape[1])
    if total_pixels <= MAX_RENDER_PIXELS:
        return lon_row, lat_col, values, 1

    stride = int(math.ceil(math.sqrt(total_pixels / MAX_RENDER_PIXELS)))
    return lon_row[::stride], lat_col[::stride], values[::stride, ::stride], stride


def sanitize_values(values: np.ndarray, source_url: str) -> np.ndarray:
    product_config = product_config_for_source(source_url)
    cleaned = values.astype(np.float32, copy=True)
    cleaned[~np.isfinite(cleaned)] = np.nan
    cleaned[cleaned < float(product_config["minimumValue"])] = np.nan
    return cleaned


def scale_values_for_product(values: np.ndarray, source_url: str) -> np.ndarray:
    product_config = product_config_for_source(source_url)
    value_scale = float(product_config.get("valueScale", 1.0))
    value_offset = float(product_config.get("valueOffset", 0.0))
    if value_scale == 1.0 and value_offset == 0.0:
        return values

    transformed = values.astype(np.float32, copy=False) * value_scale
    if value_offset != 0.0:
        transformed = transformed + value_offset

    return transformed


def build_texture(values: np.ndarray, source_url: str) -> tuple[bytes, dict[str, float]]:
    valid_mask = np.isfinite(values)
    if not np.any(valid_mask):
        raise ValueError("The reflectivity field does not contain any finite values.")

    product_config = product_config_for_source(source_url)
    palette_values = [float(value) for value in product_config["palette"].get("values", [])]
    finite_values = values[valid_mask]
    data_min = float(np.min(finite_values))
    data_max = float(np.max(finite_values))
    if data_max <= data_min:
        data_max = data_min + 1e-6

    if palette_values:
        display_min = palette_values[0]
        display_max = palette_values[-1]
    else:
        display_min = float(np.percentile(finite_values, 1.0))
        display_max = float(np.percentile(finite_values, 99.5))
        if display_max <= display_min:
            display_min = data_min
            display_max = data_max

    scale = 254.0 / (data_max - data_min)
    quantized = np.zeros(values.shape, dtype=np.uint8)
    quantized[valid_mask] = np.clip(
        np.rint((values[valid_mask] - data_min) * scale) + 1.0,
        1,
        255,
    ).astype(np.uint8)

    packed = np.flipud(quantized).tobytes()
    compressed = gzip.compress(packed, compresslevel=6, mtime=0)
    stats = {
        "dataMin": data_min,
        "dataMax": data_max,
        "displayMin": display_min,
        "displayMax": display_max,
    }
    return compressed, stats


def cache_is_fresh(paths: dict[str, Path]) -> bool:
    if not paths["meta"].exists() or not paths["texture"].exists():
        return False

    newest_mtime = max(paths["meta"].stat().st_mtime, paths["texture"].stat().st_mtime)
    return (time.time() - newest_mtime) <= CACHE_TTL_SECONDS


def remove_dataset_files(source_url: str) -> None:
    paths = cached_paths(dataset_key(source_url))
    for path in paths.values():
        path.unlink(missing_ok=True)


def prune_dataset_cache(active_sources: list[str]) -> None:
    active_keys = {dataset_key(source_url) for source_url in active_sources}
    for source_path in SOURCE_DIR.glob("*.grib2"):
        key = source_path.stem
        if key in active_keys:
            continue

        source_path.unlink(missing_ok=True)
        (DATASET_DIR / f"{key}.json").unlink(missing_ok=True)
        (DATASET_DIR / f"{key}.luma.gz").unlink(missing_ok=True)


def create_dataset(source_url: str, key: str) -> dict[str, Any]:
    paths = cached_paths(key)
    source_path = download_grib(source_url, key)
    product_config = product_config_for_source(source_url)

    with pygrib.open(str(source_path)) as grib_file:
        message = pick_product_message(grib_file, source_url)
        values = message.values.astype(np.float32)
        latitudes, longitudes = message.latlons()

    lon_row, values = normalize_longitudes(longitudes[0, :], values)
    lat_col = latitudes[:, 0]
    if lat_col[0] < lat_col[-1]:
        lat_col = lat_col[::-1]
        values = np.flipud(values)

    lon_row, lat_col, values, stride = downsample_grid(lon_row, lat_col, values)
    values = scale_values_for_product(values, source_url)
    values = sanitize_values(values, source_url)
    texture_bytes, stats = build_texture(values, source_url)

    west, east, south, north = compute_edge_bounds(lon_row, lat_col)

    metadata = {
        "datasetId": key,
        "productId": product_config["id"],
        "productLabel": product_config["label"],
        "sourceUrl": source_url,
        "field": getattr(message, "name", None) if getattr(message, "name", None) not in {None, "unknown"} else product_config["label"],
        "level": getattr(message, "typeOfLevel", None) if getattr(message, "typeOfLevel", None) not in {None, "unknown"} else "heightAboveSea",
        "units": getattr(message, "units", None) if getattr(message, "units", None) not in {None, "unknown"} else product_config["unitsFallback"],
        "analysisTime": getattr(message, "analDate", None).isoformat() if getattr(message, "analDate", None) else None,
        "validTime": getattr(message, "validDate", None).isoformat() if getattr(message, "validDate", None) else None,
        "width": int(values.shape[1]),
        "height": int(values.shape[0]),
        "sourceWidth": int(longitudes.shape[1]),
        "sourceHeight": int(latitudes.shape[0]),
        "downsampleStride": stride,
        "bounds": {
            "west": west,
            "east": east,
            "south": max(south, -90.0),
            "north": min(north, 90.0),
        },
        "mercatorBounds": {
            "west": west,
            "east": east,
            "south": max(south, -MERCATOR_MAX_LAT),
            "north": min(north, MERCATOR_MAX_LAT),
        },
        "encoding": {
            "textureFormat": "luminance8",
            "packing": "0=no-data, 1..255=quantized data",
            "compression": "gzip",
            "valueRange": stats,
        },
        "palette": product_config["palette"],
        "textureUrl": f"/api/reflectivity/{key}.bin",
    }

    paths["meta"].write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    paths["texture"].write_bytes(texture_bytes)
    return metadata


def ensure_dataset(source_url: str) -> dict[str, Any]:
    ensure_cache_dirs()
    if not is_nomads_url(source_url):
        raise ValueError("Only NOMADS HTTP(S) URLs are allowed in this demo.")

    key = dataset_key(source_url)
    paths = cached_paths(key)
    if cache_is_fresh(paths):
        return json.loads(paths["meta"].read_text(encoding="utf-8"))

    return create_dataset(source_url, key)


def recent_history_payload(source_url: str) -> list[dict[str, str]]:
    history = list_recent_mrms_sources(source_url, limit=MRMS_HISTORY_LIMIT)
    prune_dataset_cache([entry["sourceUrl"] for entry in history])
    return history


@app.get("/")
def index() -> Any:
    return send_from_directory(app.static_folder, "index.html")


@app.get("/favicon.ico")
def favicon() -> Response:
    return Response(status=204)


@app.get("/api/config")
def app_config() -> Any:
    history = recent_history_payload(DEFAULT_SOURCE_URL)
    return jsonify(
        {
            "defaultMapboxToken": DEFAULT_MAPBOX_TOKEN,
            "defaultProductId": DEFAULT_PRODUCT_ID,
            "defaultSourceUrl": DEFAULT_SOURCE_URL,
            "history": history,
            "products": product_payloads(),
        }
    )


@app.get("/api/reflectivity")
def dataset_metadata() -> Any:
    source_url = request.args.get("source", DEFAULT_SOURCE_URL)
    try:
        metadata = ensure_dataset(source_url)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to download GRIB2 source: {exc}"}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400

    return jsonify(metadata)


@app.get("/api/reflectivity/history")
def dataset_history() -> Any:
    source_url = request.args.get("source", DEFAULT_SOURCE_URL)
    try:
        history = recent_history_payload(source_url)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to fetch MRMS directory listing: {exc}"}), 502
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": str(exc)}), 400

    return jsonify({"frames": history})


@app.get("/api/reflectivity/<dataset_id>.bin")
def dataset_texture(dataset_id: str) -> Response:
    texture_path = DATASET_DIR / f"{dataset_id}.luma.gz"
    if not texture_path.exists():
        return Response("Dataset texture not found.", status=404)

    payload = texture_path.read_bytes()
    return Response(
        payload,
        headers={
            "Content-Type": "application/octet-stream",
            "Content-Encoding": "gzip",
            "Cache-Control": "public, max-age=3600",
        },
    )


if __name__ == "__main__":
    ensure_cache_dirs()
    app.run(debug=True, port=5000)
