#!/usr/bin/env node
/**
 * Green Button XML to SQL Converter
 *
 * Converts Hydro One Green Button XML export to SQL INSERT statements
 * for direct import into Home Assistant's statistics tables via phpMyAdmin.
 *
 * Usage:
 *   node scripts/greenbutton-to-sql.js <input.xml> [output.sql]
 *
 * Example:
 *   node scripts/greenbutton-to-sql.js .sample-data/Hydro1_Electric_60_Minute_12-14-2023_12-12-2025.xml backfill.sql
 *
 * Output:
 *   - SQL file with INSERT statements for statistics_meta and statistics tables
 *   - Generates both hourly TOU data and daily aggregates
 *
 * Statistics Generated:
 *   Hourly (from raw data):
 *     - hydroone:on_peak, hydroone:mid_peak, hydroone:off_peak (kWh)
 *     - hydroone:on_peak_cost, hydroone:mid_peak_cost, hydroone:off_peak_cost (CAD)
 *   Daily (aggregated):
 *     - hydroone:daily_usage (kWh)
 *     - hydroone:daily_cost (CAD)
 */

const fs = require('fs');
const path = require('path');
const xml2js = require('xml2js');

// Configuration
const CONFIG = {
  costDivisor: 100000,
  consumptionDivisor: 1000000,
  timezone: 'America/Toronto',
  touMapping: {
    1: 'On-Peak',
    2: 'Mid-Peak',
    3: 'Off-Peak'
  },
  statisticIds: {
    onPeak: 'hydroone:on_peak',
    midPeak: 'hydroone:mid_peak',
    offPeak: 'hydroone:off_peak',
    onPeakCost: 'hydroone:on_peak_cost',
    midPeakCost: 'hydroone:mid_peak_cost',
    offPeakCost: 'hydroone:off_peak_cost',
    dailyUsage: 'hydroone:daily_usage',
    dailyCost: 'hydroone:daily_cost'
  }
};

/**
 * Deep search for a key in an object (handles namespaced XML)
 */
function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;

  // Direct match
  if (obj[key] !== undefined) return obj[key];

  // Check namespaced versions
  for (const k of Object.keys(obj)) {
    if (k === key || k.endsWith(':' + key) || k.startsWith(key + ':')) {
      return obj[k];
    }
  }

  return null;
}

/**
 * Get value from potentially nested object (handles xml2js structure)
 */
function getValue(obj, key) {
  const val = findKey(obj, key);
  if (val === null || val === undefined) return null;

  // xml2js with explicitArray: false still sometimes returns arrays
  if (Array.isArray(val)) return val[0];

  // Handle nested text content
  if (typeof val === 'object' && val._) return val._;

  return val;
}

/**
 * Parse Green Button XML and extract interval readings
 */
async function parseGreenButtonXML(xmlPath) {
  const xmlContent = fs.readFileSync(xmlPath, 'utf-8');
  const parser = new xml2js.Parser({
    tagNameProcessors: [xml2js.processors.stripPrefix],  // Remove namespace prefixes
    attrNameProcessors: [xml2js.processors.stripPrefix]
    // Note: explicitArray defaults to true, which we need for proper array handling
  });
  const result = await parser.parseStringPromise(xmlContent);

  const readings = [];
  const entries = result.feed.entry || [];

  for (const entry of entries) {
    // content is an array, get first element
    const content = entry.content && entry.content[0];
    if (!content) continue;

    // IntervalBlock is an array of daily blocks
    const intervalBlocks = content.IntervalBlock;
    if (!intervalBlocks) continue;

    for (const block of intervalBlocks) {
      // Each block has IntervalReading array (24 hourly readings)
      const intervalReadings = block.IntervalReading;
      if (!intervalReadings) continue;

      for (const reading of intervalReadings) {
        // Get timePeriod (array with single element)
        const timePeriod = reading.timePeriod && reading.timePeriod[0];
        if (!timePeriod) continue;

        const startTimestamp = parseInt(timePeriod.start && timePeriod.start[0]);
        const duration = parseInt(timePeriod.duration && timePeriod.duration[0]);

        // Only process electricity readings (duration 3600 = hourly)
        if (duration !== 3600) continue;

        const value = parseInt((reading.value && reading.value[0]) || 0);
        const cost = parseInt((reading.cost && reading.cost[0]) || 0);
        const tou = parseInt((reading.tou && reading.tou[0]) || 3); // Default to Off-Peak if not specified

        // Skip weather readings (no cost/value)
        if (value === 0 && cost === 0) continue;

        readings.push({
          timestamp: startTimestamp,
          consumption: value / CONFIG.consumptionDivisor,  // Convert to kWh
          cost: cost / CONFIG.costDivisor,                 // Convert to dollars
          tou: tou,
          touName: CONFIG.touMapping[tou] || 'Off-Peak'
        });
      }
    }
  }

  // Sort by timestamp
  readings.sort((a, b) => a.timestamp - b.timestamp);

  return readings;
}

/**
 * Group hourly readings by TOU tier
 */
function groupByTOU(readings) {
  const groups = {
    onPeak: [],      // tou = 1
    midPeak: [],     // tou = 2
    offPeak: []      // tou = 3
  };

  for (const reading of readings) {
    switch (reading.tou) {
      case 1:
        groups.onPeak.push(reading);
        break;
      case 2:
        groups.midPeak.push(reading);
        break;
      case 3:
      default:
        groups.offPeak.push(reading);
        break;
    }
  }

  return groups;
}

/**
 * Aggregate hourly readings into daily totals
 */
function aggregateToDaily(readings) {
  const dailyMap = new Map();

  for (const reading of readings) {
    // Convert timestamp to date string (midnight Toronto time)
    const date = new Date(reading.timestamp * 1000);
    // Get date in Toronto timezone
    const torontoDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
    const dateKey = torontoDate.toISOString().split('T')[0];

    if (!dailyMap.has(dateKey)) {
      dailyMap.set(dateKey, {
        date: dateKey,
        consumption: 0,
        cost: 0
      });
    }

    const daily = dailyMap.get(dateKey);
    daily.consumption += reading.consumption;
    daily.cost += reading.cost;
  }

  // Convert to array and sort by date
  const dailyArray = Array.from(dailyMap.values());
  dailyArray.sort((a, b) => a.date.localeCompare(b.date));

  // Convert date strings to midnight timestamps (Toronto timezone)
  return dailyArray.map(d => {
    // Parse date and set to midnight Toronto time
    const [year, month, day] = d.date.split('-').map(Number);
    // Create date at midnight UTC, then adjust for Toronto timezone
    const utcDate = new Date(Date.UTC(year, month - 1, day, 5, 0, 0)); // 5 AM UTC = midnight EST
    return {
      timestamp: Math.floor(utcDate.getTime() / 1000),
      consumption: d.consumption,
      cost: d.cost,
      date: d.date
    };
  });
}

/**
 * Generate SQL for statistics_meta table
 */
function generateMetaSQL() {
  const metas = [
    { id: CONFIG.statisticIds.onPeak, name: 'HydroOne On-Peak', unit: 'kWh' },
    { id: CONFIG.statisticIds.midPeak, name: 'HydroOne Mid-Peak', unit: 'kWh' },
    { id: CONFIG.statisticIds.offPeak, name: 'HydroOne Off-Peak', unit: 'kWh' },
    { id: CONFIG.statisticIds.onPeakCost, name: 'HydroOne On-Peak Cost', unit: 'CAD' },
    { id: CONFIG.statisticIds.midPeakCost, name: 'HydroOne Mid-Peak Cost', unit: 'CAD' },
    { id: CONFIG.statisticIds.offPeakCost, name: 'HydroOne Off-Peak Cost', unit: 'CAD' },
    { id: CONFIG.statisticIds.dailyUsage, name: 'HydroOne Daily Usage', unit: 'kWh' },
    { id: CONFIG.statisticIds.dailyCost, name: 'HydroOne Daily Cost', unit: 'CAD' }
  ];

  let sql = '-- Statistics Metadata\n';
  sql += '-- Run these INSERT statements first. If records already exist, they will be ignored.\n\n';

  for (const meta of metas) {
    sql += `INSERT IGNORE INTO statistics_meta (statistic_id, source, unit_of_measurement, has_mean, has_sum, name) VALUES ('${meta.id}', 'hydroone', '${meta.unit}', 0, 1, '${meta.name}');\n`;
  }

  return sql;
}

/**
 * Generate SQL INSERT statements for a single statistic
 */
function generateStatisticSQL(statisticId, readings, valueField) {
  if (readings.length === 0) return '';

  let sql = `\n-- ${statisticId}\n`;
  sql += `-- ${readings.length} records\n`;

  // Calculate cumulative sums
  let cumulativeSum = 0;
  const values = [];

  for (const reading of readings) {
    const value = reading[valueField];
    cumulativeSum += value;

    // Round to 6 decimal places to avoid floating point issues
    const roundedValue = Math.round(value * 1000000) / 1000000;
    const roundedSum = Math.round(cumulativeSum * 1000000) / 1000000;

    // Home Assistant stores timestamps as UNIX epoch seconds (DOUBLE precision).
    // Use the reading timestamp directly so DST transitions remain unique.
    const startTs = typeof reading.timestamp === 'number'
      ? reading.timestamp
      : Math.floor(new Date(reading.timestamp).getTime() / 1000);
    const createdTs = typeof reading.created_ts === 'number'
      ? reading.created_ts
      : (typeof reading.createdTs === 'number'
        ? reading.createdTs
        : startTs);

    values.push(`((SELECT id FROM statistics_meta WHERE statistic_id = '${statisticId}'), ${createdTs}, ${startTs}, ${roundedValue}, ${roundedSum})`);
  }

  // Batch inserts for efficiency (500 per batch)
  // Using INSERT IGNORE to skip any records that already exist (preserves existing data)
  const batchSize = 500;
  for (let i = 0; i < values.length; i += batchSize) {
    const batch = values.slice(i, i + batchSize);
    sql += `INSERT IGNORE INTO statistics (metadata_id, created_ts, start_ts, state, sum) VALUES\n`;
    sql += batch.join(',\n') + ';\n';
  }

  return sql;
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node greenbutton-to-sql.js <input.xml> [output.sql] [--clear]');
    console.error('');
    console.error('Options:');
    console.error('  --clear    Include DELETE statements to clear existing hydroone statistics');
    console.error('');
    console.error('Example:');
    console.error('  node scripts/greenbutton-to-sql.js .sample-data/Hydro1_Electric_60_Minute_12-14-2023_12-12-2025.xml backfill.sql');
    console.error('  node scripts/greenbutton-to-sql.js .sample-data/Hydro1_Electric_60_Minute_12-14-2023_12-12-2025.xml backfill.sql --clear');
    process.exit(1);
  }

  const inputPath = args.find(a => !a.startsWith('--') && a.endsWith('.xml'));
  const outputPath = args.find(a => !a.startsWith('--') && a.endsWith('.sql')) || inputPath.replace('.xml', '.sql');
  const clearExisting = args.includes('--clear');

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Parsing Green Button XML: ${inputPath}`);
  const readings = await parseGreenButtonXML(inputPath);
  console.log(`Found ${readings.length} hourly readings`);

  if (readings.length === 0) {
    console.error('Error: No valid readings found in XML file');
    process.exit(1);
  }

  // Get date range
  const firstDate = new Date(readings[0].timestamp * 1000);
  const lastDate = new Date(readings[readings.length - 1].timestamp * 1000);
  console.log(`Date range: ${firstDate.toISOString().split('T')[0]} to ${lastDate.toISOString().split('T')[0]}`);

  // Group by TOU tier
  const touGroups = groupByTOU(readings);
  console.log(`  On-Peak:  ${touGroups.onPeak.length} readings`);
  console.log(`  Mid-Peak: ${touGroups.midPeak.length} readings`);
  console.log(`  Off-Peak: ${touGroups.offPeak.length} readings`);

  // Aggregate to daily
  const dailyReadings = aggregateToDaily(readings);
  console.log(`Aggregated to ${dailyReadings.length} daily records`);

  // Generate SQL
  let sql = '-- Green Button to Home Assistant Statistics Import\n';
  sql += `-- Generated: ${new Date().toISOString()}\n`;
  sql += `-- Source: ${path.basename(inputPath)}\n`;
  sql += `-- Date range: ${firstDate.toISOString().split('T')[0]} to ${lastDate.toISOString().split('T')[0]}\n`;
  sql += `-- Total hourly readings: ${readings.length}\n`;
  sql += `-- Total daily records: ${dailyReadings.length}\n`;
  sql += '\n';

  // Add DELETE statements if --clear flag is used
  if (clearExisting) {
    sql += '-- ==========================================\n';
    sql += '-- CLEARING EXISTING DATA\n';
    sql += '-- ==========================================\n';
    sql += 'DELETE FROM statistics WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += 'DELETE FROM statistics_short_term WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += '\n';
    console.log('Including DELETE statements to clear existing data');
  } else {
    sql += '-- NOTE: Using INSERT IGNORE to skip duplicate records.\n';
    sql += '-- To clear existing data first, run with --clear flag or execute:\n';
    sql += '-- DELETE FROM statistics WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += '-- DELETE FROM statistics_short_term WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE \'hydroone:%\');\n';
    sql += '\n';
  }

  // Generate metadata SQL
  sql += generateMetaSQL();
  sql += '\n';

  // Generate hourly TOU statistics
  sql += '\n-- ==========================================\n';
  sql += '-- HOURLY TOU STATISTICS\n';
  sql += '-- ==========================================\n';

  sql += generateStatisticSQL(CONFIG.statisticIds.onPeak, touGroups.onPeak, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.midPeak, touGroups.midPeak, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.offPeak, touGroups.offPeak, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.onPeakCost, touGroups.onPeak, 'cost');
  sql += generateStatisticSQL(CONFIG.statisticIds.midPeakCost, touGroups.midPeak, 'cost');
  sql += generateStatisticSQL(CONFIG.statisticIds.offPeakCost, touGroups.offPeak, 'cost');

  // Generate daily statistics
  sql += '\n-- ==========================================\n';
  sql += '-- DAILY AGGREGATE STATISTICS\n';
  sql += '-- ==========================================\n';

  sql += generateStatisticSQL(CONFIG.statisticIds.dailyUsage, dailyReadings, 'consumption');
  sql += generateStatisticSQL(CONFIG.statisticIds.dailyCost, dailyReadings, 'cost');

  // Write output
  fs.writeFileSync(outputPath, sql);
  console.log(`\nSQL written to: ${outputPath}`);
  console.log(`\nNext steps:`);
  console.log(`1. Open phpMyAdmin and select your Home Assistant database`);
  console.log(`2. Go to the SQL tab`);
  console.log(`3. First, clear existing data (optional but recommended):`);
  console.log(`   DELETE FROM statistics WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%');`);
  console.log(`   DELETE FROM statistics_short_term WHERE metadata_id IN (SELECT id FROM statistics_meta WHERE statistic_id LIKE 'hydroone:%');`);
  console.log(`4. Copy and paste the contents of ${outputPath}`);
  console.log(`5. Execute the SQL`);

  // Summary stats
  const totalConsumption = readings.reduce((sum, r) => sum + r.consumption, 0);
  const totalCost = readings.reduce((sum, r) => sum + r.cost, 0);
  console.log(`\nSummary:`);
  console.log(`  Total consumption: ${totalConsumption.toFixed(2)} kWh`);
  console.log(`  Total cost: $${totalCost.toFixed(2)}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
