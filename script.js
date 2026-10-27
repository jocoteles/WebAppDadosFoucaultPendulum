// script.js

// -----------------------------------------------------------------------------
// Configurações e Constantes Globais
// -----------------------------------------------------------------------------

// Configuração do Firebase carregada de config.js
// firebaseConfig e APP_CHECK_PUBLIC_KEY devem estar definidos globalmente.

// Parâmetros de Visualização e Comportamento
const THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR = 5.67; // Taxa de precessão teórica em graus por hora. Ajuste para sua latitude!
const MIN_POINTS_FOR_FIT = 3;                         // Mínimo de pontos para realizar um ajuste linear.
const INITIAL_VIEW_HOURS = 3;                         // Janela de visualização inicial preferencial em horas.
const MIN_POINTS_INITIAL_VIEW = 10;                   // Mínimo de pontos para mostrar na visualização inicial, se menos de INITIAL_VIEW_HOURS cobrir menos pontos.
const MAX_INITIAL_VIEW_POINTS = 200;                  // Máximo de pontos a mostrar na visualização inicial se "todos os pontos" for a opção. Evita sobrecarregar com muitos dados.
const ANGLE_DECIMAL_PLACES = 2;                       // Número de casas decimais para exibir ângulos.

// Elementos DOM
const precessionChartCtx = document.getElementById('precessionChart').getContext('2d');
const btnLinearFit = document.getElementById('btnLinearFit');
const btnExportData = document.getElementById('btnExportData');
const btnExpandY = document.getElementById('btnExpandY');
const btnExpandX = document.getElementById('btnExpandX');
const btnMod180 = document.getElementById('btnMod180');
const btnModAccumulative = document.getElementById('btnModAccumulative');
const currentPrecessionSpeedEl = document.getElementById('currentPrecessionSpeed');
const meanPrecessionSpeedEl = document.getElementById('meanPrecessionSpeed');
const stdDevPrecessionSpeedEl = document.getElementById('stdDevPrecessionSpeed');

// Submúltiplos inteiros de 180° para a escala vertical do modo acumulativo
const SUBMULTIPLES_OF_180 = [1, 2, 3, 4, 5, 6, 9, 10, 12, 15, 18, 20, 30, 36, 45, 60, 90, 180];

// Variáveis Globais
let precessionChart;
let allDataPoints = [];              // Armazena todos os pontos {timestamp, angle180}
let isFirstLoad = true;              // Para controlar a configuração inicial do zoom
let currentGraphicMode = '180';      // '180' (padrão) ou 'accumulative'
let currentFitData = null;           // Guarda o ajuste linear realizado para persistência durante zoom/pan

// -----------------------------------------------------------------------------
// Inicialização do Firebase e App Check
// -----------------------------------------------------------------------------
let database;

if (typeof firebaseConfig !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    database = firebase.database();
} else {
    console.error("Firebase configuration not found. Please check config.js");
}

// -----------------------------------------------------------------------------
// Funções Utilitárias
// -----------------------------------------------------------------------------

/**
 * Converte timestamp (ms) para horas desde o início da era Unix.
 * @param {number} timestamp - Timestamp em segundos.
 * @returns {number} Tempo em horas.
 */
function timestampToHours(timestamp) {
    return timestamp / (1000 * 60 * 60);
}

/**
 * Normaliza um ângulo para o intervalo [0, 360) graus.
 * @param {number} angle - Ângulo em graus.
 * @returns {number} Ângulo normalizado.
 */
function normalizeAngle(angle) {
    return ((angle % 360) + 360) % 360;
}

/**
 * Encontra o submúltiplo inteiro de 180° mais adequado para o span vertical informado.
 * Garante que a escala tenha passos exatos (ex: 18°, 36°, etc.).
 * @param {number} ySpan - Variação do eixo Y visível.
 * @returns {number} Submúltiplo inteiro de 180°.
 */
function getBestSubmultipleStep(ySpan) {
    if (!ySpan || ySpan <= 0) return 18;
    const target = ySpan / 5; // Mira em cerca de 4 a 6 divisões na escala
    let best = SUBMULTIPLES_OF_180[0];
    let minDiff = Math.abs(best - target);
    for (let i = 1; i < SUBMULTIPLES_OF_180.length; i++) {
        const diff = Math.abs(SUBMULTIPLES_OF_180[i] - target);
        if (diff < minDiff) {
            minDiff = diff;
            best = SUBMULTIPLES_OF_180[i];
        }
    }
    return best;
}

/**
 * Calcula a regressão linear usando a biblioteca simple-statistics.
 * @param {Array<{x: number, y: number}>} points - Array de objetos com x (tempo em horas) e y (ângulo).
 * @returns {object|null} Objeto com slope (m), intercept (b), rSquared, e stdDevResiduals, ou null.
 *                        A biblioteca simple-statistics chama slope de 'm' e intercept de 'b'.
 */
function calculateLinearRegressionWithLib(points) {
    if (points.length < MIN_POINTS_FOR_FIT) return null;

    const n = points.length;
    // Deslocar X para o primeiro ponto para melhorar a estabilidade numérica
    const x0 = points[0].x;
    const dataForLib = points.map(p => [p.x - x0, p.y]);

    try {
        const linearRegression = ss.linearRegression(dataForLib); // { m: slope, b: intercept_shifted }
        const lineFunctionShifted = ss.linearRegressionLine(linearRegression);

        let sumSquaredErrors = 0;
        let sumX = 0;
        let sumX2 = 0;
        
        points.forEach(p => {
            const dx = p.x - x0;
            const predictedY = lineFunctionShifted(dx);
            sumSquaredErrors += Math.pow(p.y - predictedY, 2);
            sumX += dx;
            sumX2 += dx * dx;
        });

        // Graus de liberdade para regressão linear simples (y = mx + b) é n - 2
        const stdDevResiduals = n > 2 ? Math.sqrt(sumSquaredErrors / (n - 2)) : 0;

        // Erro padrão da inclinação (slope error)
        // SE_slope = stdDevResiduals / sqrt(sum((xi - meanX)^2))
        // sum((xi - meanX)^2) = sum(xi^2) - (sum(xi)^2 / n)
        const sumSquaredDeviationsX = sumX2 - (Math.pow(sumX, 2) / n);
        const slopeError = (n > 2 && sumSquaredDeviationsX > 0) 
            ? stdDevResiduals / Math.sqrt(sumSquaredDeviationsX) 
            : 0;

        return {
            slope: linearRegression.m,
            intercept: linearRegression.b - linearRegression.m * x0, // Intercepto original no x=0
            rSquared: ss.rSquared(dataForLib, lineFunctionShifted),
            stdDevResiduals: stdDevResiduals,
            slopeError: slopeError
        };
    } catch (error) {
        console.error("Erro ao calcular regressão linear com simple-statistics:", error);
        return null;
    }
}

/**
 * Calcula a regressão linear para um conjunto de pontos.
 * @param {Array<{x: number, y: number}>} points - Array de objetos com propriedades x (tempo em horas) e y (ângulo).
 * @returns {object|null} Objeto com slope, intercept, rSquared, stdDevResiduals, ou null.
 */
function calculateLinearRegression(points) {
    if (points.length < MIN_POINTS_FOR_FIT) return null;
    
    const n = points.length;
    const x0 = points[0].x;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    
    points.forEach(p => {
        const dx = p.x - x0;
        sumX += dx; sumY += p.y; sumXY += dx * p.y; sumX2 += dx * dx; sumY2 += p.y * p.y;
    });

    const denominator = (n * sumX2 - sumX * sumX);
    if (Math.abs(denominator) < 1e-9) return null;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    const interceptShifted = (sumY - slope * sumX) / n;
    const intercept = interceptShifted - slope * x0;

    const rNumerator = (n * sumXY - sumX * sumY);
    const rDenominator = Math.sqrt(denominator * (n * sumY2 - sumY * sumY));
    const rSquared = rDenominator === 0 ? 1 : Math.pow(rNumerator / rDenominator, 2);

    let sumSquaredErrors = 0;
    points.forEach(p => {
        const dx = p.x - x0;
        const predictedY = slope * dx + interceptShifted;
        sumSquaredErrors += Math.pow(p.y - predictedY, 2);
    });

    const stdDevResiduals = n > 2 ? Math.sqrt(sumSquaredErrors / (n - 2)) : 0;
    const sumSquaredDeviationsX = sumX2 - (Math.pow(sumX, 2) / n);
    const slopeError = (n > 2 && sumSquaredDeviationsX > 0) 
        ? stdDevResiduals / Math.sqrt(sumSquaredDeviationsX) 
        : 0;

    return { slope, intercept, rSquared, stdDevResiduals, slopeError };
}

// -----------------------------------------------------------------------------
// Funções do Gráfico e Interação
// -----------------------------------------------------------------------------

/**
 * Inicializa o gráfico de precessão com plugin de zoom.
 */
function initializeChart() {
    Chart.register(ChartZoom);

    // Rastreia a posição do mouse no canvas para o zoom dinâmico
    precessionChartCtx.canvas.addEventListener('mousemove', (e) => {
        precessionChartCtx.canvas._mouseX = e.offsetX;
        precessionChartCtx.canvas._mouseY = e.offsetY;
    });

    // Função para determinar o modo de zoom com base na posição do mouse
    function getDynamicZoomMode({ chart }) {
        const x = chart.canvas._mouseX || 0;
        const y = chart.canvas._mouseY || 0;
        const chartArea = chart.chartArea;

        if (!chartArea) return 'xy';

        // Eixo Y: cursor à esquerda da área de plotagem
        if (x < chartArea.left) {
            return 'y';
        }

        // Eixo X: cursor abaixo da área de plotagem
        if (y > chartArea.bottom) {
            return 'x';
        }

        return 'xy';
    }

    precessionChart = new Chart(precessionChartCtx, {
        type: 'scatter',
        data: {
            datasets: [
                { // Dados Experimentais (índice 0)
                    label: 'Ângulo Observado (°)',
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.6)',
                    data: [],
                    pointRadius: 4,
                    showLine: false,
                    order: 2
                },
                { // Ajuste Linear (índice 1)
                    label: 'Ajuste Linear',
                    type: 'line',
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.1)',
                    borderWidth: 2,
                    data: [],
                    pointRadius: 0,
                    fill: false,
                    hidden: true,
                    order: 0
                },
                { // Precessão Teórica (índice 2)
                    label: `Precessão Teórica (${THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR.toFixed(2)}°/h)`,
                    type: 'line',
                    borderColor: 'rgb(54, 162, 235)',
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    data: [],
                    pointRadius: 0,
                    fill: false,
                    hidden: true,
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'time',
                    time: {
                        tooltipFormat: 'DD/MM/YYYY HH:mm:ss',
                        displayFormats: {
                            second: 'HH:mm:ss',
                            minute: 'HH:mm',
                            hour: 'HH:mm',
                            day: 'DD/MM',
                            week: 'DD/MM',
                            month: 'MMM YYYY',
                            quarter: '[Q]Q YYYY',
                            year: 'YYYY'
                        },
                    },
                    title: { display: true, text: 'Tempo' },
                },
                y: {
                    title: { display: true, text: 'Ângulo de Precessão (0° - 180°)' },
                    min: 0,
                    max: 180,
                    ticks: {
                        stepSize: 36,
                        callback: function (value) {
                            return value.toFixed(0) + '°';
                        }
                    }
                }
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) label += ': ';
                            if (context.parsed.y !== null) {
                                label += context.parsed.y.toFixed(ANGLE_DECIMAL_PLACES) + '°';
                            }
                            return label;
                        }
                    }
                },
                zoom: {
                    pan: {
                        enabled: true,
                        mode: getDynamicZoomMode,
                        onPanComplete: handleZoomPan
                    },
                    zoom: {
                        wheel: { enabled: true, speed: 0.1 },
                        pinch: { enabled: true },
                        mode: getDynamicZoomMode,
                        onZoomComplete: handleZoomPan
                    }
                }
            }
        },
        plugins: [{
            id: 'modBoundaryLines',
            afterDraw(chart) {
                // Desenha linhas tracejadas a cada 180° somente no modo acumulativo
                if (currentGraphicMode !== 'accumulative') return;
                const yScale = chart.scales.y;
                const xScale = chart.scales.x;
                if (!yScale || !xScale) return;

                const step = 180;
                const ctx = chart.ctx;
                const yMin = yScale.min;
                const yMax = yScale.max;

                const firstBoundary = Math.ceil(yMin / step) * step;

                ctx.save();
                ctx.strokeStyle = 'rgba(255, 150, 50, 0.45)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([6, 4]);

                for (let boundary = firstBoundary; boundary <= yMax; boundary += step) {
                    if (boundary <= yMin || boundary >= yMax) continue;
                    const yPixel = yScale.getPixelForValue(boundary);
                    ctx.beginPath();
                    ctx.moveTo(xScale.left, yPixel);
                    ctx.lineTo(xScale.right, yPixel);
                    ctx.stroke();

                    ctx.save();
                    ctx.setLineDash([]);
                    ctx.fillStyle = 'rgba(200, 100, 0, 0.85)';
                    ctx.font = '10px sans-serif';
                    ctx.textAlign = 'right';
                    ctx.fillText(`${boundary}°`, xScale.left - 4, yPixel - 3);
                    ctx.restore();
                }
                ctx.restore();
            }
        }]
    });
}

/**
 * Obtém os dados de `precessionChart` que estão atualmente visíveis no gráfico
 * (considerando tanto os limites horizontais quanto verticais).
 * @returns {Array<{x: number, y: number}>} Array de pontos visíveis {x: timestamp, y: angulo}.
 */
function getVisibleChartData() {
    if (!precessionChart || !allDataPoints.length) return [];
    const minX = precessionChart.scales.x ? precessionChart.scales.x.min : precessionChart.options.scales.x.min;
    const maxX = precessionChart.scales.x ? precessionChart.scales.x.max : precessionChart.options.scales.x.max;
    const minY = precessionChart.scales.y ? precessionChart.scales.y.min : precessionChart.options.scales.y.min;
    const maxY = precessionChart.scales.y ? precessionChart.scales.y.max : precessionChart.options.scales.y.max;

    const datasetPoints = precessionChart.data.datasets[0].data;
    if (!datasetPoints || datasetPoints.length === 0) return [];

    return datasetPoints.filter(p => {
        const inX = (minX === undefined || p.x >= minX) && (maxX === undefined || p.x <= maxX);
        const inY = (minY === undefined || p.y >= minY) && (maxY === undefined || p.y <= maxY);
        return inX && inY;
    });
}

/**
 * Converte a série de dados para o modo acumulativo contínuo:
 * Quando detecta uma transição com queda superior a 90° (diff < -90) entre pontos
 * na imediação de 180° (prev > 90 e curr < 90), soma 180° acumulativamente por transição.
 * @returns {Array<{x: number, y: number}>} Pontos acumulados para plotagem.
 */
function computeAccumulativePoints() {
    if (!allDataPoints || allDataPoints.length === 0) return [];
    const result = [];
    let cumulativeOffset = 0;

    result.push({
        x: allDataPoints[0].timestamp,
        y: allDataPoints[0].angle180
    });

    for (let i = 1; i < allDataPoints.length; i++) {
        const prev = allDataPoints[i - 1].angle180;
        const curr = allDataPoints[i].angle180;
        const diff = curr - prev;

        // Transição com queda superior a 90° entre pontos na vizinhança de 180° (ex: 178° -> 2°)
        if (diff < -90 && prev > 90 && curr < 90) {
            cumulativeOffset += 180;
        }

        result.push({
            x: allDataPoints[i].timestamp,
            y: curr + cumulativeOffset
        });
    }

    return result;
}

/**
 * Sincroniza a posição das linhas de ajuste linear e teórico já calculadas,
 * mantendo os pontos de fixação e alinhamento sem recalcular ou perder o ajuste.
 */
function syncFitLinesPosition() {
    if (!precessionChart || !currentFitData) {
        if (precessionChart) {
            precessionChart.data.datasets[1].data = [];
            precessionChart.data.datasets[1].hidden = true;
            precessionChart.data.datasets[2].data = [];
            precessionChart.data.datasets[2].hidden = true;
        }
        return;
    }

    precessionChart.data.datasets[1].data = [
        { x: currentFitData.firstTimestamp, y: currentFitData.baseFitYStart },
        { x: currentFitData.lastTimestamp, y: currentFitData.baseFitYEnd }
    ];
    precessionChart.data.datasets[2].data = [
        { x: currentFitData.firstTimestamp, y: currentFitData.baseTheoYStart },
        { x: currentFitData.lastTimestamp, y: currentFitData.baseTheoYEnd }
    ];

    precessionChart.data.datasets[1].hidden = false;
    precessionChart.data.datasets[2].hidden = false;
}

/**
 * Atualiza os pontos de dados no gráfico de acordo com o modo ativo,
 * sem forçar ou resetar os limites de zoom e pan do usuário.
 */
function updateChartDisplayData() {
    if (!precessionChart) return;

    if (currentGraphicMode === '180') {
        precessionChart.data.datasets[0].data = allDataPoints.map(p => ({
            x: p.timestamp,
            y: p.angle180
        }));
        precessionChart.options.scales.y.title.text = 'Ângulo de Precessão (0° - 180°)';
    } else {
        precessionChart.data.datasets[0].data = computeAccumulativePoints();
        precessionChart.options.scales.y.title.text = 'Ângulo Acumulado de Precessão (°)';
    }

    syncFitLinesPosition();
}

/**
 * Chamado após uma interação de zoom ou pan.
 * Sincroniza as opções com os limites atuais da escala sem forçar recálculo de zoom.
 */
function handleZoomPan() {
    if (!precessionChart || !allDataPoints.length) return;

    if (precessionChart.scales.x) {
        precessionChart.options.scales.x.min = precessionChart.scales.x.min;
        precessionChart.options.scales.x.max = precessionChart.scales.x.max;
    }
    if (precessionChart.scales.y) {
        precessionChart.options.scales.y.min = precessionChart.scales.y.min;
        precessionChart.options.scales.y.max = precessionChart.scales.y.max;
    }

    syncFitLinesPosition();
    precessionChart.update('none');
}

/**
 * Expande verticalmente: o menor e o maior valor vertical dos dados ocupam,
 * respectivamente, a base e o topo da janela gráfica.
 */
function expandVertically() {
    if (!precessionChart || !allDataPoints.length) return;
    const datasetPoints = precessionChart.data.datasets[0].data;
    if (!datasetPoints || datasetPoints.length === 0) return;

    const xMin = precessionChart.scales.x ? precessionChart.scales.x.min : precessionChart.options.scales.x.min;
    const xMax = precessionChart.scales.x ? precessionChart.scales.x.max : precessionChart.options.scales.x.max;

    // Considera os pontos na janela horizontal visível
    const visiblePoints = datasetPoints.filter(p => (xMin === undefined || p.x >= xMin) && (xMax === undefined || p.x <= xMax));
    const pointsToConsider = visiblePoints.length > 0 ? visiblePoints : datasetPoints;

    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of pointsToConsider) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }

    if (minY === Infinity || maxY === -Infinity) return;

    if (minY === maxY) {
        minY -= 1;
        maxY += 1;
    }

    precessionChart.options.scales.y.min = minY;
    precessionChart.options.scales.y.max = maxY;

    const span = maxY - minY;
    const step = getBestSubmultipleStep(span);
    precessionChart.options.scales.y.ticks.stepSize = step;

    syncFitLinesPosition();
    precessionChart.update();
}

/**
 * Expande horizontalmente: o menor e o maior valor horizontal (tempo) ocupam,
 * respectivamente, a base e o topo (esquerda e direita) da janela gráfica.
 */
function expandHorizontally() {
    if (!precessionChart || !allDataPoints.length) return;

    const minX = allDataPoints[0].timestamp;
    const maxX = allDataPoints[allDataPoints.length - 1].timestamp;

    if (minX === maxX) {
        precessionChart.options.scales.x.min = minX - 3600000;
        precessionChart.options.scales.x.max = maxX + 3600000;
    } else {
        precessionChart.options.scales.x.min = minX;
        precessionChart.options.scales.x.max = maxX;
    }

    syncFitLinesPosition();
    precessionChart.update();
}

/**
 * Limpa o ajuste linear exibido e reseta os cartões de estatísticas.
 */
function clearLinearFit() {
    currentFitData = null;
    meanPrecessionSpeedEl.textContent = "- N/A -";
    stdDevPrecessionSpeedEl.textContent = "- N/A -";
    if (precessionChart) {
        precessionChart.data.datasets[1].data = [];
        precessionChart.data.datasets[1].hidden = true;
        precessionChart.data.datasets[2].data = [];
        precessionChart.data.datasets[2].hidden = true;
        precessionChart.update();
    }
}

/**
 * Realiza o ajuste linear EXCLUSIVAMENTE nos dados VISÍVEIS no momento do clique.
 * Não recalcula automaticamente quando o zoom ou pan mudar.
 */
function performAndDisplayLinearFit() {
    if (!precessionChart || !allDataPoints.length) return;

    const visibleData = getVisibleChartData();

    if (visibleData.length < MIN_POINTS_FOR_FIT) {
        alert(`São necessários pelo menos ${MIN_POINTS_FOR_FIT} pontos na janela de visualização para o ajuste linear.`);
        clearLinearFit();
        return;
    }

    const pointsForFit = visibleData.map(p => ({
        x: timestampToHours(p.x),
        y: p.y
    }));

    const fit = calculateLinearRegressionWithLib(pointsForFit);

    if (fit) {
        const firstPoint = pointsForFit[0];
        const lastPoint = pointsForFit[pointsForFit.length - 1];
        const firstTimestamp = visibleData[0].x;
        const lastTimestamp = visibleData[visibleData.length - 1].x;

        const fitYStart = fit.slope * firstPoint.x + fit.intercept;
        const fitYEnd = fit.slope * lastPoint.x + fit.intercept;

        // Linha Teórica passando pelo centroide dos dados ajustados
        let sumX = 0;
        let sumY = 0;
        pointsForFit.forEach(p => {
            sumX += p.x;
            sumY += p.y;
        });
        const meanX = sumX / pointsForFit.length;
        const meanY = sumY / pointsForFit.length;
        const interceptTheoretical = meanY - THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * meanX;

        const theoYStart = THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * firstPoint.x + interceptTheoretical;
        const theoYEnd = THEORETICAL_PRECESSION_RATE_DEG_PER_HOUR * lastPoint.x + interceptTheoretical;

        // Atualiza estatísticas na interface
        meanPrecessionSpeedEl.textContent = `${fit.slope.toFixed(3)} ± ${fit.slopeError.toFixed(3)} °/hora (R²=${fit.rSquared.toFixed(3)})`;
        stdDevPrecessionSpeedEl.textContent = `${fit.stdDevResiduals.toFixed(ANGLE_DECIMAL_PLACES)} °`;

        // Armazena dados do ajuste para persistência durante zoom e pan
        currentFitData = {
            mode: currentGraphicMode,
            firstTimestamp: firstTimestamp,
            lastTimestamp: lastTimestamp,
            firstTimeHours: firstPoint.x,
            lastTimeHours: lastPoint.x,
            slope: fit.slope,
            intercept: fit.intercept,
            interceptTheoretical: interceptTheoretical,
            baseFitYStart: fitYStart,
            baseFitYEnd: fitYEnd,
            baseTheoYStart: theoYStart,
            baseTheoYEnd: theoYEnd
        };

        syncFitLinesPosition();
        precessionChart.update();
    } else {
        alert("Não foi possível calcular o ajuste linear para os pontos selecionados.");
        clearLinearFit();
    }
}

/**
 * Exporta os dados atualmente visíveis no gráfico para um arquivo CSV.
 */
function exportVisibleDataToCSV() {
    const visibleData = getVisibleChartData();
    if (visibleData.length === 0) {
        alert("Não há dados visíveis para exportar.");
        return;
    }

    let csvContent = "data:text/csv;charset=utf-8,Timestamp (ms),Data Hora,Angulo (°)\n";
    visibleData.forEach(p => {
        const dateTimeString = moment(p.x).format('YYYY-MM-DD HH:mm:ss');
        csvContent += `${p.x},${dateTimeString},${p.y.toFixed(ANGLE_DECIMAL_PLACES)}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    const timestampStr = moment().format('YYYYMMDD_HHmmss');
    link.setAttribute("download", `precessao_pendulo_visivel_${timestampStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Processa a atualização de dados (novos dados do Firebase).
 */
function processDataUpdate() {
    if (!precessionChart) return;

    // Calcula velocidade atual com os dois últimos pontos de allDataPoints
    if (allDataPoints.length >= 2) {
        const lastPoint = allDataPoints[allDataPoints.length - 1];
        const secondLastPoint = allDataPoints[allDataPoints.length - 2];
        const deltaTimeHours = (lastPoint.timestamp - secondLastPoint.timestamp) / (1000 * 60 * 60);
        if (deltaTimeHours > 0) {
            const diff = lastPoint.angle180 - secondLastPoint.angle180;
            const deltaAngle = diff - 180 * Math.round(diff / 180);
            const currentSpeed = deltaAngle / deltaTimeHours;
            currentPrecessionSpeedEl.textContent = `${currentSpeed.toFixed(2)} °/hora`;
        } else {
            currentPrecessionSpeedEl.textContent = `- N/A -`;
        }
    } else {
        currentPrecessionSpeedEl.textContent = `- N/A -`;
    }

    // Janela de visualização inicial para o eixo X
    if (isFirstLoad && allDataPoints.length > 0) {
        let initialMinTimestamp;
        let initialMaxTimestamp = allDataPoints[allDataPoints.length - 1].timestamp;

        if (allDataPoints.length === 1) {
            initialMinTimestamp = allDataPoints[0].timestamp - (1 * 1000 * 60 * 60);
            initialMaxTimestamp = allDataPoints[0].timestamp + (1 * 1000 * 60 * 60);
        } else {
            const threeHoursAgo = initialMaxTimestamp - (INITIAL_VIEW_HOURS * 1000 * 60 * 60);
            const firstPointOverallTimestamp = allDataPoints[0].timestamp;

            if (threeHoursAgo < firstPointOverallTimestamp || allDataPoints.length < MIN_POINTS_INITIAL_VIEW) {
                const startIndex = Math.max(0, allDataPoints.length - MAX_INITIAL_VIEW_POINTS);
                initialMinTimestamp = allDataPoints[startIndex].timestamp;
            } else {
                initialMinTimestamp = threeHoursAgo;
            }
        }

        precessionChart.options.scales.x.min = initialMinTimestamp;
        precessionChart.options.scales.x.max = initialMaxTimestamp;
        precessionChart.options.scales.y.min = 0;
        precessionChart.options.scales.y.max = 180;
        precessionChart.options.scales.y.ticks.stepSize = 36;
        isFirstLoad = false;
    } else if (isFirstLoad && allDataPoints.length === 0) {
        delete precessionChart.options.scales.x.min;
        delete precessionChart.options.scales.x.max;
        isFirstLoad = false;
    }

    updateChartDisplayData();
    precessionChart.update();
}

// -----------------------------------------------------------------------------
// Listeners de Eventos e Busca de Dados
// -----------------------------------------------------------------------------

btnLinearFit.addEventListener('click', performAndDisplayLinearFit);
btnExportData.addEventListener('click', exportVisibleDataToCSV);
btnExpandY.addEventListener('click', expandVertically);
btnExpandX.addEventListener('click', expandHorizontally);

btnMod180.addEventListener('click', () => {
    if (currentGraphicMode === '180') return;
    currentGraphicMode = '180';
    btnMod180.classList.add('active');
    btnMod180.classList.remove('inactive-mode');
    btnModAccumulative.classList.remove('active');
    btnModAccumulative.classList.add('inactive-mode');

    clearLinearFit();

    precessionChart.data.datasets[0].data = allDataPoints.map(p => ({
        x: p.timestamp,
        y: p.angle180
    }));
    precessionChart.options.scales.y.title.text = 'Ângulo de Precessão (0° - 180°)';
    precessionChart.options.scales.y.min = 0;
    precessionChart.options.scales.y.max = 180;
    precessionChart.options.scales.y.ticks.stepSize = 36;

    syncFitLinesPosition();
    precessionChart.update();
});

btnModAccumulative.addEventListener('click', () => {
    if (currentGraphicMode === 'accumulative') return;
    currentGraphicMode = 'accumulative';
    btnModAccumulative.classList.add('active');
    btnModAccumulative.classList.remove('inactive-mode');
    btnMod180.classList.remove('active');
    btnMod180.classList.add('inactive-mode');

    clearLinearFit();

    const accumPoints = computeAccumulativePoints();
    precessionChart.data.datasets[0].data = accumPoints;
    precessionChart.options.scales.y.title.text = 'Ângulo Acumulado de Precessão (°)';

    // Ajusta a escala vertical aos pontos acumulados visíveis
    const xMin = precessionChart.scales.x ? precessionChart.scales.x.min : precessionChart.options.scales.x.min;
    const xMax = precessionChart.scales.x ? precessionChart.scales.x.max : precessionChart.options.scales.x.max;
    const visiblePoints = accumPoints.filter(p => (xMin === undefined || p.x >= xMin) && (xMax === undefined || p.x <= xMax));
    const pointsToConsider = visiblePoints.length > 0 ? visiblePoints : accumPoints;

    let minY = Infinity, maxY = -Infinity;
    pointsToConsider.forEach(p => {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    });

    if (minY !== Infinity && maxY !== -Infinity) {
        const span = Math.max(1, maxY - minY);
        const step = getBestSubmultipleStep(span);
        precessionChart.options.scales.y.min = Math.floor(minY / step) * step;
        precessionChart.options.scales.y.max = Math.ceil(maxY / step) * step;
        precessionChart.options.scales.y.ticks.stepSize = step;
    }

    syncFitLinesPosition();
    precessionChart.update();
});

const dataRef = database.ref('pendulum_sensor_data').orderByChild('timestamp');

dataRef.on('value', (snapshot) => {
    console.log("Novos dados recebidos do Firebase!");
    const rawData = [];

    const MAX_ERROR_DEV = 0.5; // Filtra falhas graves da visão computacional
    const MAX_PHYSICAL_SPEED_DEG_PER_HOUR = 25.0; // Limite de velocidade física plausível (~5.67°/h teórica em Araras-SP)

    snapshot.forEach((childSnapshot) => {
        const data = childSnapshot.val();
        if (data && typeof data.timestamp === 'number' && typeof data.angle_degrees === 'number') {
            if (typeof data.error_deviation === 'number' && data.error_deviation > MAX_ERROR_DEV) {
                return;
            }

            const currentTimestamp = data.timestamp > 1e11 ? data.timestamp : data.timestamp * 1000;
            // Normaliza o ângulo bruto para o intervalo [0, 180) registrado no Firebase
            const rawAngle180 = ((data.angle_degrees % 180) + 180) % 180;
            rawData.push({
                timestamp: currentTimestamp,
                rawAngle: rawAngle180,
                errorDev: data.error_deviation
            });
        }
    });

    rawData.sort((a, b) => a.timestamp - b.timestamp);

    const tempData = [];
    let lastValidRaw = null;
    let lastValidTs = null;

    for (let i = 0; i < rawData.length; i++) {
        const item = rawData[i];

        if (lastValidRaw !== null) {
            const dtHours = (item.timestamp - lastValidTs) / (1000 * 3600);
            const diff = item.rawAngle - lastValidRaw;
            const delta = diff - 180 * Math.round(diff / 180);

            // Gating de velocidade física
            if (dtHours > 0 && dtHours < 1.0) {
                const speed = Math.abs(delta) / dtHours;
                if (speed > MAX_PHYSICAL_SPEED_DEG_PER_HOUR) {
                    continue; // Descarta salto não-físico
                }
            }
        }

        lastValidRaw = item.rawAngle;
        lastValidTs = item.timestamp;

        tempData.push({
            timestamp: item.timestamp,
            angle180: item.rawAngle
        });
    }

    allDataPoints = tempData;
    processDataUpdate();
}, (error) => {
    console.error("Erro ao buscar dados do Firebase:", error);
    alert("Não foi possível carregar os dados da precessão.");
});

// -----------------------------------------------------------------------------
// Inicialização
// -----------------------------------------------------------------------------
window.onload = () => {
    initializeChart();
};