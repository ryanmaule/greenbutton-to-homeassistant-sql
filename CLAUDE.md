# CLAUDE.md - Project Context for Claude Code

## Project Purpose
This project converts Hydro One Green Button XML exports to SQL statements for direct import into Home Assistant's MariaDB statistics tables. It enables historical backfill of electricity usage data without relying on web scraping (which has issues with captchas and rate limiting).

## Background
- **Parent project**: Forked from a HydroOne web scraper that was becoming unreliable due to captchas and throttling
- **Solution**: Green Button XML exports provide up to 2 years of historical data in a standard format
- **Target**: Home Assistant's `statistics` and `statistics_meta` tables in MariaDB

## Key Files
- `greenbutton-to-sql.js` - Main converter script (Node.js)
- `import/` - Green Button XML files from Hydro One
- `export/` - Generated SQL files for phpMyAdmin import

## Import File Analysis (as of 2025-12-30)
| File | Date Range | Hourly Readings | Notes |
|------|------------|-----------------|-------|
| `Hydro1_Electric_60_Minute_12-30-2023_12-28-2025.xml` | 2023-12-30 to 2025-12-28 | 17,508 | Newest, extends to Dec 28 |
| `Hydro1_Electric_60_Minute_12-14-2023_12-12-2025.xml` | 2023-12-14 to 2025-12-13 | 17,520 | Has 16 extra early days |
| `DownLoadMyData_1.xml` | 2025-01-02 to 2025-12-12 | 16,464 | Subset, no TOU data |

**Best approach**: Merge Dec 14-29, 2023 data from older file with newer file for complete coverage.

## Statistics Generated (8 total)
### Hourly TOU Statistics
- `hydroone:on_peak` - On-Peak consumption (kWh)
- `hydroone:mid_peak` - Mid-Peak consumption (kWh)
- `hydroone:off_peak` - Off-Peak consumption (kWh)
- `hydroone:on_peak_cost` - On-Peak cost (CAD)
- `hydroone:mid_peak_cost` - Mid-Peak cost (CAD)
- `hydroone:off_peak_cost` - Off-Peak cost (CAD)

### Daily Aggregates
- `hydroone:daily_usage` - Total daily consumption (kWh)
- `hydroone:daily_cost` - Total daily cost (CAD)

## Data Conversions
- Raw value ÷ 1,000,000 = kWh
- Raw cost ÷ 100,000 = CAD
- TOU codes: 1=On-Peak, 2=Mid-Peak, 3=Off-Peak

## Complete Backfill Process

### Step 1: Download Green Button Data from Hydro One
1. Log in to [Hydro One MyAccount](https://www.hydroone.com/myaccount)
2. Navigate to **Usage** → **Download My Data**
3. Select **Green Button XML** format
4. Choose maximum date range (up to 2 years)
5. Save XML file to `import/` folder

### Step 2: Generate SQL (with merge if needed)
```bash
# If you have one XML file:
node greenbutton-to-sql.js import/Hydro1_Electric_60_Minute_YYYY_YYYY.xml export/hydroone_DATERANGE.sql --clear

# If you have multiple XML files to merge (to maximize date coverage):
node merge-greenbutton.js \
  "import/Hydro1_Electric_60_Minute_12-30-2023_12-28-2025.xml" \
  "import/Hydro1_Electric_60_Minute_12-14-2023_12-12-2025.xml" \
  "export/hydroone_2023-12-14_to_2025-12-28_hourly_daily.sql" --clear
```

### Step 3: Import via SSH (Recommended - avoids phpMyAdmin timeouts)
```bash
# Copy SQL to Home Assistant server
scp export/hydroone_2023-12-14_to_2025-12-28_hourly_daily.sql homeassistant:/tmp/

# Install MariaDB client (first time only)
ssh homeassistant "apk add mariadb-client"

# Run the import (password from /config/secrets.yaml mariadb_url)
ssh homeassistant "mariadb -h core-mariadb -u homeassistant -p'CottageL1f3' --skip-ssl homeassistant < /tmp/hydroone_2023-12-14_to_2025-12-28_hourly_daily.sql"
```

### Step 4: Verify Import
```bash
# Check record counts by statistic
ssh homeassistant "mariadb -h core-mariadb -u homeassistant -p'CottageL1f3' --skip-ssl homeassistant -e 'SELECT statistic_id, COUNT(*) as records FROM statistics s JOIN statistics_meta m ON s.metadata_id = m.id WHERE m.statistic_id LIKE \"hydroone:%\" GROUP BY statistic_id'"

# Check date range
ssh homeassistant "mariadb -h core-mariadb -u homeassistant -p'CottageL1f3' --skip-ssl homeassistant -e 'SELECT FROM_UNIXTIME(MIN(start_ts)) as earliest, FROM_UNIXTIME(MAX(start_ts)) as latest FROM statistics WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \"hydroone:%\")'"
```

### Expected Results (as of 2025-12-30)
| Statistic | Records |
|-----------|---------|
| hydroone:on_peak | 3,060 |
| hydroone:mid_peak | 3,060 |
| hydroone:off_peak | 11,772 |
| hydroone:on_peak_cost | 3,060 |
| hydroone:mid_peak_cost | 3,060 |
| hydroone:off_peak_cost | 11,772 |
| hydroone:daily_usage | 746 |
| hydroone:daily_cost | 746 |
| **Total** | **37,276** |

Date range: 2023-12-14 to 2025-12-28

## SSH Access Setup
The `homeassistant` SSH alias should be configured in `~/.ssh/config`:
```
Host homeassistant
    HostName <your-ha-ip>
    User root
    Port 22
```

## MariaDB Connection Details
- **Host**: `core-mariadb` (Docker internal hostname)
- **User**: `homeassistant`
- **Password**: In `/config/secrets.yaml` → `mariadb_url`
- **Database**: `homeassistant`
- **Flag**: `--skip-ssl` required (HA's MariaDB addon doesn't use SSL internally)

## Troubleshooting
- **Negative values in HA**: Caused by running incremental scraper on existing data. Must clear and reimport from scratch using `--clear` flag.
- **phpMyAdmin timeout**: Use SSH direct import instead (see Step 3 above)
- **Duplicate key errors**: Use `--clear` flag or manually delete existing data first
- **SSL error**: Add `--skip-ssl` flag to mariadb command

## Dependencies
- Node.js 14+
- `xml2js` package (`npm install xml2js`)
