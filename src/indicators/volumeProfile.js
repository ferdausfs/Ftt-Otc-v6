/**
 * Volume Profile Analysis
 * POC (Point of Control), Value Area, Single Prints
 * Works with approximate data from TwelveData or exact from Binance
 */

import { safeLastValue, r2 } from '../utils/helpers.js';

/**
 * Calculate Volume Profile from candles
 */
export function analyzeVolumeProfile(candles, rows = 24) {
  if (!candles || candles.length < 20) {
    return {
      poc: null,
      valueAreaHigh: null,
      valueAreaLow: null,
      singlePrints: [],
      nearPOC: false,
      inValueArea: false,
      volumeSpike: false,
      valid: false
    };
  }
  
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);
  
  const maxPrice = Math.max(...highs);
  const minPrice = Math.min(...lows);
  const rowSize = (maxPrice - minPrice) / rows;
  
  if (rowSize === 0) {
    return { valid: false, reason: 'No price range' };
  }
  
  // Build volume histogram
  const histogram = new Array(rows).fill(0);
  const rowPrices = [];
  
  for (let i = 0; i < rows; i++) {
    const rowLow = minPrice + i * rowSize;
    const rowHigh = rowLow + rowSize;
    rowPrices.push({ low: rowLow, high: rowHigh, mid: (rowLow + rowHigh) / 2 });
    
    for (let j = 0; j < candles.length; j++) {
      const candle = candles[j];
      const candleMid = (candle.high + candle.low) / 2;
      
      if (candleMid >= rowLow && candleMid < rowHigh) {
        histogram[i] += volumes[j] || 0;
      }
    }
  }
  
  // POC: Row with highest volume
  const maxVolume = Math.max(...histogram);
  const pocIndex = histogram.indexOf(maxVolume);
  const poc = rowPrices[pocIndex].mid;
  
  // Value Area: 70% of volume
  const totalVolume = histogram.reduce((a, b) => a + b, 0);
  const targetVolume = totalVolume * 0.70;
  
  let valueAreaStart = pocIndex;
  let valueAreaEnd = pocIndex;
  let currentVolume = histogram[pocIndex];
  
  // Expand outward from POC until 70% volume captured
  while (currentVolume < targetVolume && (valueAreaStart > 0 || valueAreaEnd < rows - 1)) {
    const volBelow = valueAreaStart > 0 ? histogram[valueAreaStart - 1] : 0;
    const volAbove = valueAreaEnd < rows - 1 ? histogram[valueAreaEnd + 1] : 0;
    
    if (volBelow >= volAbove && valueAreaStart > 0) {
      valueAreaStart--;
      currentVolume += volBelow;
    } else if (valueAreaEnd < rows - 1) {
      valueAreaEnd++;
      currentVolume += volAbove;
    } else if (valueAreaStart > 0) {
      valueAreaStart--;
      currentVolume += volBelow;
    } else {
      break;
    }
  }
  
  const valueAreaLow = rowPrices[valueAreaStart].low;
  const valueAreaHigh = rowPrices[valueAreaEnd].high;
  
  // Single Prints: Low volume nodes (potential fast move zones)
  const avgRowVolume = totalVolume / rows;
  const singlePrints = [];
  
  for (let i = 0; i < rows; i++) {
    if (histogram[i] < avgRowVolume * 0.3 && histogram[i] > 0) {
      singlePrints.push({
        price: rowPrices[i].mid,
        volume: histogram[i],
        relativeVolume: r2(histogram[i] / avgRowVolume)
      });
    }
  }
  
  // Current price position
  const currentPrice = safeLastValue(candles.map(c => c.close));
  const nearPOC = Math.abs(currentPrice - poc) / poc < 0.002;
  const inValueArea = currentPrice >= valueAreaLow && currentPrice <= valueAreaHigh;
  
  // Volume spike detection (last candle vs average)
  const recentVolumes = candles.slice(-10).map(c => c.volume || 0);
  const avgRecentVolume = recentVolumes.slice(0, -1).reduce((a, b) => a + b, 0) / 9;
  const lastVolume = candles[candles.length - 1].volume || 0;
  const volumeSpike = avgRecentVolume > 0 && lastVolume > avgRecentVolume * 1.5;
  
  return {
    valid: true,
    poc: r2(poc),
    valueAreaHigh: r2(valueAreaHigh),
    valueAreaLow: r2(valueAreaLow),
    valueAreaRange: r2(valueAreaHigh - valueAreaLow),
    singlePrints: singlePrints.slice(0, 3), // Top 3
    nearPOC,
    inValueArea,
    aboveValueArea: currentPrice > valueAreaHigh,
    belowValueArea: currentPrice < valueAreaLow,
    volumeSpike,
    volumeSpikeRatio: avgRecentVolume > 0 ? r2(lastVolume / avgRecentVolume) : 0,
    currentPrice: r2(currentPrice),
    distanceToPOC: r2(((currentPrice - poc) / poc) * 100) // in percent
  };
}
