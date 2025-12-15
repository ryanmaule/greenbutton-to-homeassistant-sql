# Green Button XML to SQL Converter

Convert Hydro One Green Button XML exports to SQL for direct import into Home Assistant's statistics database.

## Overview

This tool parses [Green Button](https://www.greenbuttondata.org/) XML exports from Hydro One and generates SQL INSERT statements compatible with Home Assistant's `statistics` and `statistics_meta` tables. This allows you to backfill historical electricity usage data directly via phpMyAdmin or any SQL client, bypassing Home Assistant's automation-based import limitations.

## Features

- Parses Green Button ESPI (Energy Services Provider Interface) XML format
- Extracts hourly readings with Time-of-Use (TOU) tier classification
- Generates both hourly TOU statistics and daily aggregates
- Handles Ontario Daylight Saving Time transitions correctly (UTC timestamps)
- Outputs SQL with proper cumulative sums for Home Assistant's statistics format
- Splits large datasets into batches for reliable phpMyAdmin import

## Requirements

- Node.js 14+
- `xml2js` package (`npm install xml2js`)

## Installation

```bash
# Clone the repository
git clone https://github.com/ryanmaule/hydroone.git
cd hydroone

# Install dependencies
npm install
```

## Usage

```bash
node scripts/greenbutton-to-sql.js <input.xml> [output.sql] [--clear]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `<input.xml>` | Path to Green Button XML export file (required) |
| `[output.sql]` | Output SQL file path (optional, defaults to input filename with `.sql` extension) |
| `--clear` | Include DELETE statements to clear existing `hydroone:*` statistics before import |

### Examples

```bash
# Basic usage - generates SQL file alongside XML
node scripts/greenbutton-to-sql.js Hydro1_Electric_60_Minute_2023-2025.xml

# Specify output file
node scripts/greenbutton-to-sql.js export.xml backfill.sql

# Clear existing data before import
node scripts/greenbutton-to-sql.js export.xml backfill.sql --clear
```

## Output

The script generates SQL that creates 8 external statistics in Home Assistant:

### Hourly TOU Statistics (from raw readings)
| Statistic ID | Unit | Description |
|--------------|------|-------------|
| `hydroone:on_peak` | kWh | On-Peak consumption |
| `hydroone:mid_peak` | kWh | Mid-Peak consumption |
| `hydroone:off_peak` | kWh | Off-Peak consumption |
| `hydroone:on_peak_cost` | CAD | On-Peak cost |
| `hydroone:mid_peak_cost` | CAD | Mid-Peak cost |
| `hydroone:off_peak_cost` | CAD | Off-Peak cost |

### Daily Aggregate Statistics
| Statistic ID | Unit | Description |
|--------------|------|-------------|
| `hydroone:daily_usage` | kWh | Total daily consumption |
| `hydroone:daily_cost` | CAD | Total daily cost |

## Obtaining Green Button Data

1. Log in to [Hydro One MyAccount](https://www.hydroone.com/myaccount)
2. Navigate to **Usage** → **Download My Data**
3. Select **Green Button XML** format
4. Choose your date range (up to 2 years available)
5. Download the XML file

## Importing to Home Assistant

### Option 1: phpMyAdmin (Recommended)

1. Open phpMyAdmin and select your Home Assistant database
2. Go to the **SQL** tab
3. If the generated SQL file is large (>1MB), split it into parts:
   ```bash
   # The script outputs batches of 500 records per INSERT
   # Split the file if phpMyAdmin times out
   ```
4. Copy and paste the SQL contents
5. Execute the SQL

### Option 2: Command Line (MariaDB/MySQL)

```bash
mysql -u homeassistant -p homeassistant < backfill.sql
```

### Option 3: SQLite (if using SQLite database)

```bash
sqlite3 /config/home-assistant_v2.db < backfill.sql
```

## Technical Details

### Data Conversions

The script applies these conversions from raw Green Button values:

| Field | Divisor | Result |
|-------|---------|--------|
| `value` | 1,000,000 | kWh |
| `cost` | 100,000 | CAD |

### TOU Tier Mapping

| TOU Code | Tier | Typical Hours (Ontario) |
|----------|------|-------------------------|
| 1 | On-Peak | Weekdays 7-11 AM, 5-7 PM |
| 2 | Mid-Peak | Weekdays 11 AM-5 PM |
| 3 | Off-Peak | Evenings, nights, weekends |

### Timestamp Handling

Timestamps are stored as Unix epoch seconds (UTC) to correctly handle:
- Daylight Saving Time transitions
- The November "fall back" day where 1:00 AM occurs twice (stored as different UTC timestamps)

### Cumulative Sums

Home Assistant statistics require cumulative `sum` values. The script calculates running totals for each statistic type, sorted chronologically.

## Troubleshooting

### phpMyAdmin Timeout

If phpMyAdmin times out importing large files:

1. Split the SQL file into smaller parts (one per statistic)
2. Import each part separately
3. Or use command-line MySQL/SQLite instead

### Duplicate Key Errors

If you see `Duplicate entry` errors:

1. The script uses `INSERT IGNORE` by default, which skips duplicates
2. To replace all data, use the `--clear` flag
3. Or manually delete existing data first:
   ```sql
   DELETE FROM statistics WHERE metadata_id IN
     (SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%');
   ```

### Statistics Not Appearing in Energy Dashboard

External statistics (with `:` in the ID) require configuration in Home Assistant's Energy Dashboard:

1. Go to **Settings** → **Dashboards** → **Energy**
2. Add the statistics under **Electricity Grid** → **Grid Consumption**

### Viewing External Statistics

External statistics don't appear in Developer Tools → Statistics. To view them:

- Use `statistics-graph` card in a dashboard
- Query the database directly via phpMyAdmin
- Use the `recorder.get_statistics` service in automations

## License

MIT License - See repository for details.

## Related Projects

- [Home Assistant](https://www.home-assistant.io/)
- [Green Button Alliance](https://www.greenbuttondata.org/)
- [Hydro One MyAccount](https://www.hydroone.com/myaccount)
