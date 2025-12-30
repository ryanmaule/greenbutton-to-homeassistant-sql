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

## Backfill Process (Critical Order)
1. **Clear existing data first** - Required because cumulative sums will be wrong otherwise
   ```sql
   DELETE FROM statistics WHERE metadata_id IN
     (SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%');
   DELETE FROM statistics_short_term WHERE metadata_id IN
     (SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%');
   ```
2. **Convert Green Button XML to SQL** using `greenbutton-to-sql.js`
3. **Import SQL via phpMyAdmin** - May need to split large files
4. **Verify import** - Check row counts and date ranges

## Common Commands
```bash
# Convert with clear flag (recommended for fresh import)
node greenbutton-to-sql.js import/file.xml export/output.sql --clear

# Convert without clearing (uses INSERT IGNORE for duplicates)
node greenbutton-to-sql.js import/file.xml export/output.sql
```

## Troubleshooting
- **Negative values in HA**: Caused by running incremental scraper on existing data. Must clear and reimport from scratch.
- **phpMyAdmin timeout**: Split SQL file or use command line: `mysql -u homeassistant -p homeassistant < file.sql`
- **Duplicate key errors**: Use `--clear` flag or manually delete existing data first

## Dependencies
- Node.js 14+
- `xml2js` package (`npm install xml2js`)
