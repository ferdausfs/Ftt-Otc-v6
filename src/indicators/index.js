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

export function calculateAllIndicators(candles) {
  const closes = candles.map(c => c.close);
  const atrArr  = calculateATR(candles, CONFIG.ATR_PERIOD);
  const atrLast = atrArr[atrArr.length - 1] || null;
  return {
    ema5:       calculateEMA(closes, 5),
    ema10:      calculateEMA(closes, 10),
    ema20:      calculateEMA(closes, 20),
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
  };
}
