// 전역 변수
let socket;
let currentMode = null;
let currentTest = null;

// 페이지 로드 시 초기화
document.addEventListener('DOMContentLoaded', function() {
    // Socket.io 연결
    socket = io();
    
    // 서버 상태 수신
    socket.on('serverState', function(data) {
        document.getElementById('tcpPort').textContent = data.tcpPort;
        updateClientList(data.connectedClients);
    });
    
    // 클라이언트 목록 업데이트
    socket.on('clientListUpdate', function(clients) {
        updateClientList(clients);
    });
    
    // 테스트 진행 상황 업데이트
    socket.on('testProgress', function(data) {
        updateTestProgress(data);
    });
    
    // 서버 IP 가져오기
    getServerIP();
});

// 모드 선택
function selectMode(mode) {
    currentMode = mode;
    document.getElementById('modeSelection').style.display = 'none';
    
    if (mode === 'server') {
        document.getElementById('serverMode').style.display = 'block';
        document.getElementById('serverMode').classList.add('fade-in');
    } else {
        document.getElementById('clientMode').style.display = 'block';
        document.getElementById('clientMode').classList.add('fade-in');
    }
}

// 모드 선택으로 돌아가기
function backToModeSelection() {
    currentMode = null;
    document.getElementById('serverMode').style.display = 'none';
    document.getElementById('clientMode').style.display = 'none';
    document.getElementById('modeSelection').style.display = 'block';
    
    // 상태 초기화
    updateConnectionStatus('disconnected');
    document.getElementById('startTestBtn').disabled = true;
}

// 서버 IP 가져오기
async function getServerIP() {
    try {
        const response = await fetch('/api/server-info');
        const data = await response.json();
        document.getElementById('serverIP').textContent = data.ip;
    } catch (error) {
        document.getElementById('serverIP').textContent = 'localhost';
    }
}

// 클라이언트 목록 업데이트
function updateClientList(clients) {
    const clientList = document.getElementById('clientList');
    
    if (clients.length === 0) {
        clientList.innerHTML = '<p class="text-muted">연결된 클라이언트가 없습니다.</p>';
        return;
    }
    
    let html = '';
    clients.forEach(client => {
        const statusClass = getStatusClass(client.status);
        const statusText = getStatusText(client.status);
        
        html += `
            <div class="client-item ${statusClass}">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <strong>${client.ip}:${client.port}</strong>
                        <span class="badge ${statusClass} ms-2">${statusText}</span>
                    </div>
                    <div class="text-end">
                        ${client.uploadSpeed > 0 ? `<div class="speed-display">업로드: ${client.uploadSpeed.toFixed(2)} MB/s</div>` : ''}
                        ${client.downloadSpeed > 0 ? `<div class="speed-display">다운로드: ${client.downloadSpeed.toFixed(2)} MB/s</div>` : ''}
                    </div>
                </div>
            </div>
        `;
    });
    
    clientList.innerHTML = html;
}

// 상태에 따른 CSS 클래스 반환
function getStatusClass(status) {
    switch (status) {
        case 'connected': return 'bg-primary';
        case 'upload_testing': return 'bg-warning';
        case 'download_testing': return 'bg-info';
        case 'upload_completed': return 'bg-success';
        case 'download_completed': return 'bg-success';
        default: return 'bg-secondary';
    }
}

// 상태에 따른 텍스트 반환
function getStatusText(status) {
    switch (status) {
        case 'connected': return '연결됨';
        case 'upload_testing': return '업로드 테스트 중';
        case 'download_testing': return '다운로드 테스트 중';
        case 'upload_completed': return '업로드 완료';
        case 'download_completed': return '다운로드 완료';
        default: return '알 수 없음';
    }
}

// 서버에 연결
function connectToServer() {
    const serverIP = document.getElementById('serverIPInput').value;
    const serverPort = parseInt(document.getElementById('serverPortInput').value);
    
    if (!serverIP || !serverPort) {
        alert('서버 IP와 포트를 입력해주세요.');
        return;
    }
    
    updateConnectionStatus('connecting');
    
    // WebSocket을 통해 서버에 연결 요청
    socket.emit('connectToTCP', { serverIP, serverPort }, function(response) {
        if (response.success) {
            console.log('TCP 서버에 연결됨');
            updateConnectionStatus('connected');
            document.getElementById('startTestBtn').disabled = false;
        } else {
            console.error('TCP 연결 실패:', response.error);
            updateConnectionStatus('error');
            alert('서버 연결에 실패했습니다: ' + response.error);
        }
    });
}

// 연결 상태 업데이트
function updateConnectionStatus(status) {
    const statusElement = document.getElementById('connectionStatus');
    let badgeClass = '';
    let statusText = '';
    
    switch (status) {
        case 'connecting':
            badgeClass = 'bg-warning';
            statusText = '<span class="spinner"></span>연결 중...';
            break;
        case 'connected':
            badgeClass = 'bg-success';
            statusText = '연결됨';
            break;
        case 'disconnected':
            badgeClass = 'bg-secondary';
            statusText = '연결되지 않음';
            break;
        case 'error':
            badgeClass = 'bg-danger';
            statusText = '연결 오류';
            break;
    }
    
    statusElement.innerHTML = `<span class="badge ${badgeClass}">${statusText}</span>`;
}

// 테스트 시작
function startTest() {
    const dataSize = parseInt(document.getElementById('dataSizeSelect').value);
    const iterations = parseInt(document.getElementById('iterationsInput').value);
    
    if (iterations < 1 || iterations > 100) {
        alert('반복 횟수는 1-100 사이로 설정해주세요.');
        return;
    }
    
    // 테스트 초기화
    testResults = [];
    currentTest = {
        dataSize: dataSize,
        iterations: iterations,
        currentIteration: 0,
        uploadResults: [],
        downloadResults: []
    };
    
    // 진행 상황 표시
    document.getElementById('progressCard').style.display = 'block';
    document.getElementById('resultsCard').style.display = 'none';
    
    // 서버에 테스트 시작 요청
    socket.emit('startTest', {
        dataSize: dataSize,
        iterations: iterations
    });
}

// 테스트 완료 처리
socket.on('testCompleted', function(data) {
    const { type, results } = data;
    
    if (type === 'upload') {
        currentTest.uploadResults = results;
        // 다운로드 테스트 시작
        socket.emit('startDownloadTest', { dataSize: currentTest.dataSize });
    } else if (type === 'download') {
        currentTest.downloadResults = results;
        showResults();
    }
});

// 진행률 업데이트
function updateProgress(type, progress) {
    if (type === 'upload') {
        document.getElementById('uploadProgress').style.width = progress + '%';
        document.getElementById('uploadProgress').textContent = Math.round(progress) + '%';
    } else {
        document.getElementById('downloadProgress').style.width = progress + '%';
        document.getElementById('downloadProgress').textContent = Math.round(progress) + '%';
    }
}

// 테스트 진행 상황 업데이트
function updateTestProgress(data) {
    if (data.type === 'upload') {
        updateProgress('upload', data.progress);
        if (data.speed > 0) {
            document.getElementById('currentSpeed').textContent = data.speed.toFixed(2) + ' MB/s';
        }
    } else {
        updateProgress('download', data.progress);
        if (data.speed > 0) {
            document.getElementById('currentSpeed').textContent = data.speed.toFixed(2) + ' MB/s';
        }
    }
}

// 결과 표시
function showResults() {
    document.getElementById('progressCard').style.display = 'none';
    document.getElementById('resultsCard').style.display = 'block';
    
    const resultsDiv = document.getElementById('testResults');
    
    // 결과 테이블 생성
    let html = `
        <table class="result-table">
            <thead>
                <tr>
                    <th>테스트 유형</th>
                    <th>데이터 크기</th>
                    <th>전송 시간 (ms)</th>
                    <th>속도 (MB/s)</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    // 업로드 결과
    currentTest.uploadResults.forEach((result, index) => {
        html += `
            <tr>
                <td>업로드 ${index + 1}</td>
                <td>${formatBytes(result.dataSize)}</td>
                <td>${result.transferTime}</td>
                <td>${result.speed.toFixed(2)}</td>
            </tr>
        `;
    });
    
    // 다운로드 결과
    currentTest.downloadResults.forEach((result, index) => {
        html += `
            <tr>
                <td>다운로드 ${index + 1}</td>
                <td>${formatBytes(result.dataSize)}</td>
                <td>${result.transferTime}</td>
                <td>${result.speed.toFixed(2)}</td>
            </tr>
        `;
    });
    
    html += '</tbody></table>';
    
    // 평균 속도 계산
    const avgUploadSpeed = currentTest.uploadResults.reduce((sum, r) => sum + r.speed, 0) / currentTest.uploadResults.length;
    const avgDownloadSpeed = currentTest.downloadResults.reduce((sum, r) => sum + r.speed, 0) / currentTest.downloadResults.length;
    
    html += `
        <div class="mt-3">
            <h6>평균 속도:</h6>
            <p>업로드: <strong>${avgUploadSpeed.toFixed(2)} MB/s</strong></p>
            <p>다운로드: <strong>${avgDownloadSpeed.toFixed(2)} MB/s</strong></p>
        </div>
    `;
    
    resultsDiv.innerHTML = html;
}

// 바이트 단위 포맷팅
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 결과 다운로드
function downloadResults() {
    // 현재 테스트 결과를 CSV로 변환하여 다운로드
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `network_test_${timestamp}.csv`;
    
    // CSV 헤더
    let csvContent = 'Timestamp,TestType,DataSize(Bytes),TransferTime(ms),Speed(MB/s),Status\n';
    
    // 업로드 결과
    currentTest.uploadResults.forEach((result, index) => {
        csvContent += `${new Date().toISOString()},Upload ${index + 1},${result.dataSize},${result.transferTime},${result.speed.toFixed(2)},Success\n`;
    });
    
    // 다운로드 결과
    currentTest.downloadResults.forEach((result, index) => {
        csvContent += `${new Date().toISOString()},Download ${index + 1},${result.dataSize},${result.transferTime},${result.speed.toFixed(2)},Success\n`;
    });
    
    // 다운로드 링크 생성
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
}
