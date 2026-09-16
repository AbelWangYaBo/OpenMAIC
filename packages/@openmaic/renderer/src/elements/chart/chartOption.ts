import type { ComposeOption } from 'echarts/core';
import type {
  BarSeriesOption,
  PictorialBarSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
  ScatterSeriesOption,
  RadarSeriesOption,
} from 'echarts/charts';
import type { ChartData, ChartType, ImportedChartStyle, ImportedChartAxis } from '@openmaic/dsl';

type EChartOption = ComposeOption<
  | PictorialBarSeriesOption
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | ScatterSeriesOption
  | RadarSeriesOption
>;

export interface ChartOptionPayload {
  type: ChartType;
  data: ChartData;
  themeColors: string[];
  textColor?: string;
  lineColor?: string;
  lineSmooth?: boolean;
  stack?: boolean;
  importedStyle?: ImportedChartStyle;
}

// ECharts paints pictorial symbols in a square SVG image box. A square wrapper
// with an explicitly stretched inner image preserves Office's stretch fill.
function stretchedPictureSymbol(src: string): string {
  const escaped = src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><image href="${escaped}" x="0" y="0" width="400" height="400" preserveAspectRatio="none"/></svg>`;
  return `image://data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export const getChartOption = ({
  type,
  data,
  themeColors,
  textColor,
  lineColor,
  lineSmooth,
  stack,
  importedStyle,
}: ChartOptionPayload): EChartOption | null => {
  const textStyle = textColor ? { color: textColor } : {};

  const axisLine = textColor ? { lineStyle: { color: textColor } } : undefined;
  const axisLabel = { show: true, color: textColor ?? '#333333' };
  const splitLine = lineColor ? { lineStyle: { color: lineColor } } : {};

  if (!Array.isArray(data?.series) || data.series.length === 0 || !Array.isArray(data.labels)) {
    return null;
  }
  const categoryAxisLabel = {
    ...axisLabel,
    interval: data.labels.length <= 8 ? 0 : ('auto' as const),
  };

  const legend = data.series.length > 1 ? { top: 'bottom' as const, textStyle } : undefined;

  if (type === 'bar' || type === 'column') {
    const hasPicture =
      !stack && importedStyle?.series.some((s) => Object.keys(s.pointImages ?? {}).length > 0);
    const axisOptions = (style: ImportedChartAxis | undefined, category: boolean) => ({
      ...(style?.show !== undefined ? { show: style.show } : {}),
      axisLine: style
        ? {
            show: style.lineVisible ?? category,
            lineStyle: { color: style.lineColor ?? textColor ?? '#333333' },
          }
        : axisLine,
      axisLabel: {
        ...(category ? categoryAxisLabel : axisLabel),
        ...(!category && /^0(?:\.0+)?%$/.test(style?.numberFormat ?? '')
          ? {
              formatter: (value: number) =>
                `${(value * 100).toFixed((style?.numberFormat?.split('.')[1]?.split('%')[0] ?? '').length)}%`,
            }
          : {}),
        ...(style?.labelVisible !== undefined ? { show: style.labelVisible } : {}),
        ...(style?.labelColor ? { color: style.labelColor } : {}),
        ...(style?.labelFontSize !== undefined ? { fontSize: style.labelFontSize } : {}),
        ...(style?.labelBold !== undefined
          ? { fontWeight: style.labelBold ? ('bold' as const) : ('normal' as const) }
          : {}),
      },
      splitLine:
        style?.gridlines !== undefined
          ? { show: style.gridlines, lineStyle: { color: style.gridlineColor ?? '#e0e6f1' } }
          : category
            ? undefined
            : splitLine,
      ...(category
        ? {}
        : {
            min:
              style?.min ??
              (style?.majorUnit && style.majorUnit > 0
                ? ({ min }: { min: number }) =>
                    Math.floor(Math.min(0, min) / style.majorUnit!) * style.majorUnit!
                : undefined),
            max:
              style?.max ??
              (style?.majorUnit && style.majorUnit > 0
                ? ({ max }: { max: number }) =>
                    Math.ceil(Math.max(0, max) / style.majorUnit!) * style.majorUnit!
                : undefined),
            interval: style?.majorUnit,
          }),
    });
    const category = {
      type: 'category' as const,
      data: data.labels,
      ...axisOptions(importedStyle?.categoryAxis, true),
    };
    const value = { type: 'value' as const, ...axisOptions(importedStyle?.valueAxis, false) };
    // Picture-filled percent columns use an extra automatic tick above the peak,
    // matching Office's automatic range while honoring explicit scale settings.
    if (
      hasPicture &&
      value.max === undefined &&
      !importedStyle?.valueAxis?.majorUnit &&
      /^0(?:\.0+)?%$/.test(importedStyle?.valueAxis?.numberFormat ?? '')
    ) {
      value.max = ({ max }: { max: number }) => {
        if (max <= 0) return 0;
        const magnitude = 10 ** Math.floor(Math.log10(max / 6));
        const unit = [1, 2, 5, 10].find((n) => n * magnitude >= max / 6)! * magnitude;
        return (Math.floor(max / unit + 1e-9) + 1) * unit;
      };
    }
    const plot = importedStyle?.plotArea;
    return {
      color: themeColors,
      textStyle,
      legend,
      ...(plot
        ? {
            grid: {
              left: `${plot.x * 100}%`,
              top: `${plot.y * 100}%`,
              width: `${plot.w * 100}%`,
              height: `${plot.h * 100}%`,
              containLabel: false,
            },
          }
        : {}),
      xAxis: type === 'bar' ? category : value,
      yAxis: type === 'bar' ? value : category,
      series: data.series.map((item, index) => {
        const style = importedStyle?.series[index];
        const picture = !stack && Object.keys(style?.pointImages ?? {}).length > 0;
        const seriesItem: BarSeriesOption | PictorialBarSeriesOption = {
          data: style
            ? item.map((n, i) => ({
                value: n,
                ...(picture
                  ? {
                      symbol: style.pointImages?.[String(i)]
                        ? stretchedPictureSymbol(style.pointImages[String(i)])
                        : 'rect',
                    }
                  : {}),
                itemStyle: {
                  color:
                    style.pointFills?.[String(i)] ??
                    style.fill ??
                    themeColors[index % themeColors.length],
                },
              }))
            : item,
          name: data.legends[index],
          type: picture ? 'pictorialBar' : 'bar',
          ...(picture
            ? { symbolSize: ['100%', '100%'], symbolRepeat: false, symbolClip: false }
            : {}),
          label: { show: style?.showValue ?? true },
          itemStyle: {
            borderRadius: importedStyle ? 0 : type === 'bar' ? [2, 2, 0, 0] : [0, 2, 2, 0],
          },
        };
        // OOXML gapWidth is the gap as a percentage of a bar's width.
        // For a single/stacked series, convert to percentage of a category band.
        if (importedStyle?.gapWidth !== undefined && (data.series.length === 1 || stack)) {
          const gap = Math.max(0, importedStyle.gapWidth);
          seriesItem.barCategoryGap = `${(gap / (100 + gap)) * 100}%`;
        }
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'line') {
    return {
      color: themeColors,
      textStyle,
      legend,
      xAxis: { type: 'category', data: data.labels, axisLine, axisLabel: categoryAxisLabel },
      yAxis: { type: 'value', axisLine, axisLabel, splitLine },
      series: data.series.map((item, index) => {
        const seriesItem: LineSeriesOption = {
          data: item,
          name: data.legends[index],
          type: 'line',
          smooth: lineSmooth,
          label: { show: true },
        };
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'pie') {
    const series0 = data.series[0];
    if (!Array.isArray(series0)) return null;
    return {
      color: themeColors,
      textStyle,
      legend: { top: 'bottom' as const, textStyle },
      series: [
        {
          data: series0.map((item, index) => ({ value: item, name: data.labels[index] })),
          label: textColor ? { color: textColor } : {},
          type: 'pie',
          radius: '70%',
          emphasis: {
            itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' },
            label: { show: true, fontSize: 14, fontWeight: 'bold' },
          },
        },
      ],
    };
  }
  if (type === 'ring') {
    const series0 = data.series[0];
    if (!Array.isArray(series0)) return null;
    return {
      color: themeColors,
      textStyle,
      legend: { top: 'bottom' as const, textStyle },
      series: [
        {
          data: series0.map((item, index) => ({ value: item, name: data.labels[index] })),
          label: textColor ? { color: textColor } : {},
          type: 'pie',
          radius: ['40%', '70%'],
          padAngle: 1,
          avoidLabelOverlap: false,
          itemStyle: { borderRadius: 4 },
          emphasis: { label: { show: true, fontSize: 14, fontWeight: 'bold' } },
        },
      ],
    };
  }
  if (type === 'area') {
    return {
      color: themeColors,
      textStyle,
      legend,
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: data.labels,
        axisLine,
        axisLabel: categoryAxisLabel,
      },
      yAxis: { type: 'value', axisLine, axisLabel, splitLine },
      series: data.series.map((item, index) => {
        const seriesItem: LineSeriesOption = {
          data: item,
          name: data.legends[index],
          type: 'line',
          areaStyle: {},
          label: { show: true },
        };
        if (stack) seriesItem.stack = 'A';
        return seriesItem;
      }),
    };
  }
  if (type === 'radar') {
    return {
      color: themeColors,
      textStyle,
      legend,
      radar: {
        indicator: data.labels.map((item) => ({ name: item })),
        splitLine,
        axisLine: lineColor ? { lineStyle: { color: lineColor } } : undefined,
      },
      series: [
        {
          data: data.series.map((item, index) => ({ value: item, name: data.legends[index] })),
          type: 'radar',
        },
      ],
    };
  }
  if (type === 'scatter') {
    const series0 = data.series[0];
    if (!Array.isArray(series0)) return null;
    const formatedData: number[][] = [];
    for (let i = 0; i < series0.length; i++) {
      const x = series0[i];
      const y = data.series[1]?.[i] ?? x;
      formatedData.push([x, y]);
    }

    return {
      color: themeColors,
      textStyle,
      xAxis: { axisLine, axisLabel, splitLine },
      yAxis: { axisLine, axisLabel, splitLine },
      series: [{ symbolSize: 12, data: formatedData, type: 'scatter' }],
    };
  }

  return null;
};
