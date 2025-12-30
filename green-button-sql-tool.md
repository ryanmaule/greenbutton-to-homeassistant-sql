---
title: Green Button SQL Tool
type: note
permalink: maule-bay-cottage/reference/green-button-sql-tool
tags:
- tool
- greenbutton
- sql
- backfill
- nodejs
---

# Green Button SQL Tool

## Context
Node.js tool that converts Hydro One Green Button XML exports to SQL for direct import into Home Assistant's statistics database. Enables historical backfill without API rate limiting concerns.

## Repository
- [fact] Public repository: `ryanmaule/greenbutton-to-homeassistant-sql` (planned) #github
- [fact] Current location: `scripts/greenbutton-to-sql.js` in hydroone repo #location
- [fact] Technology: Node.js with xml2js #stack

## Purpose
- [insight] Bypasses API scraping for large historical imports (up to 24 months) #backfill
- [insight] Avoids HydroOne rate limiting and captcha issues #reliability
- [insight] File-based import can be retried without timing issues #reliability

## Usage
```bash
node scripts/greenbutton-to-sql.js <input.xml> [output.sql] [--clear]
```

## Green Button Data Format
- [fact] ESPI (Energy Services Provider Interface) XML format #format
- [fact] Green Button is industry standard from NAESB (North American Energy Standards Board) #standard
- [fact] Hydro One exports available for up to 24 months of history #availability

## Data Conversions
- [fact] Raw value ÷ 1,000,000 = kWh (consumption) #conversion
- [fact] Raw cost ÷ 100,000 = CAD (dollars) #conversion
- [fact] TOU codes: 1=On-Peak, 2=Mid-Peak, 3=Off-Peak #tou-mapping
- [technique] Timestamps stored as Unix epoch (UTC) for correct DST handling #timestamps

## Output Statistics
- [fact] Generates 8 external statistics matching HydroOne Integration format #output
- [fact] Hourly TOU: on_peak, mid_peak, off_peak (consumption + cost) #statistics
- [fact] Daily aggregates: daily_usage, daily_cost #statistics
- [technique] SQL uses INSERT IGNORE to skip duplicates, --clear flag to replace all #sql

## Import Methods
- [technique] phpMyAdmin for web-based import (may need file splitting for large files) #import
- [technique] Command line: `mysql -u homeassistant -p homeassistant < backfill.sql` #import
- [technique] SQLite: `sqlite3 /config/home-assistant_v2.db < backfill.sql` #import

## Relations
- supports [[HydroOne Integration]]
- part_of [[Energy Monitoring System]]
