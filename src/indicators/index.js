import { ASSET_TYPE } from '../config.js';
import { CONFIG } from '../config.js';
import { safeLastValue } from '../utils/helpers.js';
import {
  calculateEMA, calculateSMA, calculateRSI, calculateMACD,
  calculateATR, calculateBollingerBands, calculateStochastic,
  calculateADX, calculateWilliamsR, calculateCCI, calculateMFI,
  calculatePivotPoints, calculateCamarillaPivots,
} from './math.js';
import { detectCandlestickPatterns } from './patterns.js';
import { detectSRLevels, detectFVG } from './sr.js';
import { detectRSIDivergence, detectMACDDivergence } from './divergence.js';

export function calculateAllIndicators(candles, assetType = ASSET_TYPE.FOREX) {
  const closes = candles.map(c => c.close);
  const atrArr  = calculateATR(candles, CONFIG.ATR_PERIOD);
  const atrLast = atrArr[atrArr.length - 1] || null;
  return {
    close:      closes,
    ema5:       calculateEMA(closes, 5),
    ema10:      calculateEMA(closes, 10),
    ema20:      calculateEMA(closes, 20),
    ema50:      calculateEMA(closes, 50),
    ema200:     calculateEMA(closes, 200),
    sma50:      calculateSMA(closes, 50),
    rsi:        calculateRSI(closes, CONFIG.RSI_PERIOD),
    macd:       calculateMACD(closes),
    atr:        atrArr,
    bollinger:  calculateBollingerBands(closes, CONFIG.BB_PERIOD, CONFIG.BB_STD_DEV),
    stochastic: calculateStochastic(candles, CONFIG.STOCH_PERIOD, CONFIG.STOCH_SMOOTH_K, CONFIG.STOCH_SMOOTH_D),
    adx:        calculateADX(candles, CONFIG.ADX_PERIOD),
    williamsR:  calculateWilliamsR(candles, CONFIG.WILLIAMS_PERIOD),
    cci:        calculateCCI(candles, CONFIG.CCI_PERIOD),
    mfi:        calculateMFI(candles, CONFIG.MFI_PERIOD),
    pivots:     calculatePivotPoints(candles),
    camarilla:  calculateCamarillaPivots(candles),
    patterns:   detectCandlestickPatterns(candles),
    sr:         detectSRLevels(candles, atrLast),
    fvg:        detectFVG(candles),
    divergence: {
      rsi:  detectRSIDivergence(candles, calculateRSI(closes, CONFIG.RSI_PERIOD)),
      macd: detectMACDDivergence(candles, calculateMACD(closes).histogram),
    },
  };
}
