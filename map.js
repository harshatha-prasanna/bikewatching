import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

mapboxgl.accessToken = 'pk.eyJ1IjoiaGFyc2hhdGhhIiwiYSI6ImNtcDdxZ2d1ZzA5MGIycXEwY2ZsNW9namUifQ.eQUr_Ph5372auJEWi0kFcQ';

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// ── D3 SVG overlay ───────────────────────────────────────────────────────────
const svg = d3.select('#map').select('svg');

// Pre-bucketed trips by minute for O(1) time-range lookups (Step 5.4)
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute   = Array.from({ length: 1440 }, () => []);

// ── Global helpers ───────────────────────────────────────────────────────────

/** Project a station's lon/lat to SVG pixel coordinates. */
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

/** Minutes elapsed since midnight for a Date object. */
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** Format a minutes-since-midnight value as a human-readable time string. */
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

/**
 * Return the flat list of trips from `tripsByMinute` whose minute falls
 * within ±60 minutes of `minute`.  Handles wrap-around across midnight.
 * If minute === -1, returns all trips.
 */
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }
  const minMinute = (minute - 60 + 1440) % 1440;
  const maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    // Range crosses midnight
    return [
      ...tripsByMinute.slice(minMinute),
      ...tripsByMinute.slice(0, maxMinute),
    ].flat();
  }
  return tripsByMinute.slice(minMinute, maxMinute).flat();
}

/**
 * Compute arrivals, departures, and totalTraffic for each station.
 * Uses the pre-bucketed minute arrays so filtering is fast.
 */
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  return stations.map((station) => {
    const id = station.short_name;
    station.arrivals     = arrivals.get(id)   ?? 0;
    station.departures   = departures.get(id) ?? 0;
    station.totalTraffic = station.arrivals + station.departures;
    return station;
  });
}

// ── Traffic-flow color scale (quantize → 3 discrete stops) ──────────────────
// 0 = all arrivals, 0.5 = balanced, 1 = all departures
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// ── Shared paint style for both bike-lane layers ─────────────────────────────
const bikeLanePaint = {
  'line-color': '#32D400',
  'line-width': 3,
  'line-opacity': 0.5,
};

// ── Map load ─────────────────────────────────────────────────────────────────
map.on('load', async () => {

  // Boston existing bike network
  map.addSource('boston-bike-lanes', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'boston-bike-lanes-layer',
    type: 'line',
    source: 'boston-bike-lanes',
    paint: bikeLanePaint,
  });

  // Cambridge bike facilities
  map.addSource('cambridge-bike-lanes', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({
    id: 'cambridge-bike-lanes-layer',
    type: 'line',
    source: 'cambridge-bike-lanes',
    paint: bikeLanePaint,
  });

  // ── Load station data ────────────────────────────────────────────────────
  let jsonData;
  try {
    jsonData = await d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json');
    console.log('Loaded JSON Data:', jsonData);
  } catch (error) {
    console.error('Error loading JSON:', error);
    return;
  }

  // ── Load trip data; parse timestamps and bucket by minute simultaneously ─
  await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at   = new Date(trip.ended_at);

      departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
      arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);

      return trip;
    },
  );

  // ── Compute initial station traffic (no time filter) ─────────────────────
  let stations = computeStationTraffic(jsonData.data.stations);
  console.log('Stations Array:', stations);

  // ── Radius scale (square-root so area encodes traffic, not radius) ────────
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  // ── Append SVG circles ───────────────────────────────────────────────────
  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r',            (d) => radiusScale(d.totalTraffic))
    .attr('stroke',       'white')
    .attr('stroke-width', 1)
    .style('--departure-ratio', (d) =>
      stationFlow(d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic),
    )
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(
          `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`,
        );
    });

  // ── Reproject circles whenever the map viewport changes ──────────────────
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  updatePositions();
  map.on('move',    updatePositions);
  map.on('zoom',    updatePositions);
  map.on('resize',  updatePositions);
  map.on('moveend', updatePositions);

  // ── Time filter ──────────────────────────────────────────────────────────
  const timeSlider   = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  /** Resize circles based on the filtered trip set. */
  function updateScatterPlot(timeFilter) {
    const filteredStations = computeStationTraffic(stations, timeFilter);

    // Expand circle sizes when filtering so sparse results stay readable
    timeFilter === -1
      ? radiusScale.range([0, 25])
      : radiusScale.range([3, 50]);

    circles
      .data(filteredStations, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic),
      );
  }

  /** Sync the time display and trigger a scatterplot update. */
  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent  = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent  = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay(); // set initial state
});
