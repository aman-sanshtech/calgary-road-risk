# Calgary Road Risk (prototype)

A map of where Calgary roads are most likely to cause winter collisions right now. It combines
nearly ten years of City of Calgary incident history, live incidents, live weather, terrain slope
and the City's live traffic cameras, then ranks locations so crews know where to plow and sand first.

It is decision support: it recommends red zones, and people decide.

## Run it

It is a static page with no build step. From this folder, serve it with any local web server:

```powershell
python -m http.server 5180
```

Then open http://localhost:5180. Opening `index.html` directly from disk will not work in every
browser, because the page fetches live data.

## What it shows

- **Risk hotspots**: about 220 m grid cells with at least 8 winter incidents (Nov–Mar), coloured red / amber / green.
- **Live incidents**: the City's current incident feed, refreshed every 2 minutes.
- **Traffic cameras**: 222 City cameras; each image refreshes about once a minute. A hotspot popup
  shows the nearest camera within 800 m.
- **Priority list**: the top 12 locations for the current conditions.
- **Scenario switch**: live forecast, or demo conditions (heavy snow, freezing rain, clear) for presenting on a dry day.

## How the score works (0–100)

| Part | Max | What it measures |
|---|---|---|
| Incident history | 40 | Winter incidents in the cell since Dec 2016 (log-scaled against the worst cell) |
| Worse in winter | 15 | Share of the cell's incidents that happen Nov–Mar, compared with the city average |
| Road grade | 15 | Steepest grade along the roads at the location (see below); 8% or more scores full marks |
| Weather | 30 | Snow (past 12 h + next 12 h), freezing rain, temperature crossing 0 °C, extreme cold; counts more on steep ground |
| Live incident nearby | 10 | A current incident within 300 m |

Red zone at 65 or above, elevated at 40 or above. The weights are starting guesses, not fitted to data yet.

### How road grade is measured

1. For each hotspot, fetch the City's Street Centreline segments that cross a 240 m box around it
   (alleys and pedestrian bridges excluded). This uses `intersects()`, not `within_circle()`:
   `within_circle()` only returns lines entirely inside the circle, so it misses long highway segments.
2. Sample elevation every 20 m along each segment, with bilinear interpolation from the terrain tiles.
3. Grade is the steepest rise over 100 m (or the whole segment if shorter), counting only the stretch
   within 200 m of the hotspot. Segments under 40 m are skipped as too noisy.
4. Which road counts: roads named in the incident location first ("Crowchild Trail approaching 16 Avenue NW"
   → Crowchild Tr and 16 Av), then major roads, then any road. This stops a steep side street from
   standing in for the main road.
5. **Bridges:** the terrain data shows the valley floor, not the bridge deck. If a segment dips more than
   4 m below both ends *and* has a stretch steeper than 12%, it's treated as a bridge and given its
   end-to-end grade. Anything still over 15% is discarded as an artifact.

This removes most of the old ground-slope errors. For example, "Glenmore Trail approaching 14 Street SW"
had 14.7% ground slope from the escarpment beside it, but the road itself is 5%. The steepest graded
hotspots are recognisable Calgary hills: John Laurie Blvd at 19 St NW (11.6%), Glenmore Tr east of
Blackfoot (10.1%), Canyon Meadows Dr down to Bow Bottom Tr (9.5%).

## Data sources and licences

| Data | Source | Licence |
|---|---|---|
| Traffic Incidents archive (`35ra-9556`), Current Traffic Incidents (`4jah-h97u`), Traffic Cameras (`k7p9-kppz`), Street Centreline (`4dx8-rtm5`) | [Open Calgary](https://data.calgary.ca) | Open Government Licence – City of Calgary v2.1. Commercial use allowed, with attribution. |
| Weather | [Open-Meteo](https://open-meteo.com) forecast API | CC BY 4.0. Free tier is for non-commercial use; a paid plan is needed for a commercial product. |
| Elevation | Mapzen Terrain Tiles on AWS Open Data | Open; attribution to the underlying sources |
| Basemap | OpenStreetMap tiles | ODbL. Fine for a demo; production needs a paid tile provider. |

Required attribution (already in the page footer): "Contains information licensed under the Open
Government Licence – City of Calgary." Don't use the City's logo or imply it endorses the product.
Don't store or analyse faces or licence plates from camera images: personal information is excluded
from the licence.

511 Alberta (highway cameras, official road conditions) isn't used yet. It needs a developer key,
allows 10 calls per minute, and doesn't publish commercial terms. Confirm with Alberta Transportation first.

## Known limitations

- **Elevation resolution is about 24 m.** Grades are smoothed, and short steep ramps can read lower than they are.
- **Bridge detection is a heuristic.** It catches decks over deep valleys, but overpasses and interchange
  ramps can still produce wrong grades. A bridge layer, or a higher-resolution model such as City LiDAR,
  would fix this.
- **Hotspots at interchanges** take the steepest named road, which may be a ramp rather than the through-road.
- **Weather is one point for the whole city.** It doesn't capture differences between neighbourhoods.
- **Incident data is "unofficial"**: the City builds it from camera monitoring, so roads without cameras are under-counted.
- **The weights are hand-set.** Next step: fit them against past winter storms.

## Next steps

1. Switch to higher-resolution elevation (LiDAR, if the City or province will share it) for sharper grades and real bridge decks.
2. Add a camera road-surface classifier (bare / wet / snow / ice) and train it on 511 Alberta's official road-condition reports.
3. Use gridded weather (several points across the city) and hourly history to back-test against past storms.
4. Add alerts by email or SMS when a location turns red, and a printable plow-priority sheet.
