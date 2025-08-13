const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const net = require('net');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 미들웨어 설정
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// 서버 상태 관리
const serverState = {
  tcpPort: 8080,
  connectedClients: new Map(), // clientId -> clientInfo
  testResults: new Map(), // clientId -> testResults
  isRunning: false
};

// TCP 서버 생성
const tcpServer = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`TCP 클라이언트 연결: ${clientId}`);
  
  // 클라이언트 정보 저장
  serverState.connectedClients.set(clientId, {
    id: clientId,
    ip: socket.remoteAddress,
    port: socket.remotePort,
    socket: socket,
    status: 'connected',
    currentTest: null,
    uploadSpeed: 0,
    downloadSpeed: 0
  });

  // WebSocket으로 클라이언트 목록 업데이트
  io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));

  socket.on('data', (data) => {
    const clientInfo = serverState.connectedClients.get(clientId);
    if (clientInfo && clientInfo.currentTest) {
      // 업로드 테스트 중인 경우
      if (clientInfo.currentTest.type === 'upload') {
        clientInfo.currentTest.receivedBytes += data.length;
        
        // 테스트 완료 체크
        if (clientInfo.currentTest.receivedBytes >= clientInfo.currentTest.totalBytes) {
          const endTime = Date.now();
          const transferTime = endTime - clientInfo.currentTest.startTime;
          const speed = (clientInfo.currentTest.totalBytes / 1024 / 1024) / (transferTime / 1000); // MB/s
          
          clientInfo.uploadSpeed = speed;
          clientInfo.currentTest = null;
          clientInfo.status = 'upload_completed';
          
          // 결과 저장
          saveTestResult(clientId, 'upload', clientInfo.currentTest.totalBytes, transferTime, speed);
          
          // WebSocket으로 업데이트
          io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
          io.emit('testProgress', { clientId, type: 'upload', progress: 100, speed });
        } else {
          // 진행률 업데이트
          const progress = (clientInfo.currentTest.receivedBytes / clientInfo.currentTest.totalBytes) * 100;
          io.emit('testProgress', { clientId, type: 'upload', progress, speed: 0 });
        }
      }
    }
  });

  socket.on('close', () => {
    console.log(`TCP 클라이언트 연결 해제: ${clientId}`);
    serverState.connectedClients.delete(clientId);
    io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
  });

  socket.on('error', (err) => {
    console.error(`TCP 클라이언트 오류: ${clientId}`, err);
    serverState.connectedClients.delete(clientId);
    io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
  });
});

// TCP 서버 시작
tcpServer.listen(serverState.tcpPort, () => {
  console.log(`TCP 서버가 포트 ${serverState.tcpPort}에서 실행 중입니다.`);
});

// WebSocket 연결 처리
io.on('connection', (socket) => {
  console.log('WebSocket 클라이언트 연결됨');

  // 서버 상태 전송
  socket.emit('serverState', {
    tcpPort: serverState.tcpPort,
    connectedClients: Array.from(serverState.connectedClients.values())
  });

  // TCP 연결 요청 처리
  socket.on('connectToTCP', (data, callback) => {
    const { serverIP, serverPort } = data;
    
    try {
      // TCP 클라이언트 생성
      const tcpClient = new net.Socket();
      
      tcpClient.connect(serverPort, serverIP, function() {
        const clientId = `${tcpClient.remoteAddress}:${tcpClient.remotePort}`;
        console.log(`TCP 클라이언트 연결됨: ${clientId}`);
        
        // 클라이언트 정보 저장
        serverState.connectedClients.set(clientId, {
          id: clientId,
          ip: tcpClient.remoteAddress,
          port: tcpClient.remotePort,
          socket: tcpClient,
          webSocket: socket,
          status: 'connected',
          currentTest: null,
          uploadSpeed: 0,
          downloadSpeed: 0
        });
        
        // WebSocket으로 클라이언트 목록 업데이트
        io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
        
        callback({ success: true, clientId });
      });
      
      tcpClient.on('data', (data) => {
        const clientId = `${tcpClient.remoteAddress}:${tcpClient.remotePort}`;
        const clientInfo = serverState.connectedClients.get(clientId);
        
        if (clientInfo && clientInfo.currentTest) {
          // 업로드 테스트 중인 경우
          if (clientInfo.currentTest.type === 'upload') {
            clientInfo.currentTest.receivedBytes += data.length;
            
            // 현재 반복 테스트 완료 체크
            if (clientInfo.currentTest.receivedBytes >= clientInfo.currentTest.dataSize) {
              const endTime = Date.now();
              const transferTime = endTime - clientInfo.currentTest.startTime;
              const speed = (clientInfo.currentTest.dataSize / 1024 / 1024) / (transferTime / 1000); // MB/s
              
              // 결과 저장
              clientInfo.currentTest.results.push({
                dataSize: clientInfo.currentTest.dataSize,
                transferTime: transferTime,
                speed: speed
              });
              
              // 진행률 업데이트
              const progress = (clientInfo.currentTest.currentIteration / clientInfo.currentTest.iterations) * 100;
              clientInfo.webSocket.emit('testProgress', { type: 'upload', progress, speed });
              
              // 다음 테스트 또는 완료
              setTimeout(() => {
                startUploadTest(clientId);
              }, 1000);
            }
          }
        }
      });
      
      tcpClient.on('close', () => {
        const clientId = `${tcpClient.remoteAddress}:${tcpClient.remotePort}`;
        console.log(`TCP 클라이언트 연결 해제: ${clientId}`);
        serverState.connectedClients.delete(clientId);
        io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
      });
      
      tcpClient.on('error', (err) => {
        console.error('TCP 클라이언트 오류:', err);
        callback({ success: false, error: err.message });
      });
      
    } catch (error) {
      console.error('TCP 연결 생성 오류:', error);
      callback({ success: false, error: error.message });
    }
  });

  // 테스트 시작 요청 처리
  socket.on('startTest', (data) => {
    const { dataSize, iterations } = data;
    
    // 현재 WebSocket에 연결된 클라이언트 찾기
    let targetClient = null;
    for (const [clientId, clientInfo] of serverState.connectedClients) {
      if (clientInfo.webSocket === socket) {
        targetClient = clientId;
        break;
      }
    }
    
    if (targetClient) {
      startTest(targetClient, dataSize, iterations);
    } else {
      console.error('연결된 클라이언트를 찾을 수 없습니다.');
    }
  });

  // 다운로드 테스트 시작
  socket.on('startDownloadTest', (data) => {
    const { dataSize } = data;
    
    // 현재 WebSocket에 연결된 클라이언트 찾기
    let targetClient = null;
    for (const [clientId, clientInfo] of serverState.connectedClients) {
      if (clientInfo.webSocket === socket) {
        targetClient = clientId;
        break;
      }
    }
    
    if (targetClient) {
      startDownloadTest(targetClient, dataSize);
    } else {
      console.error('연결된 클라이언트를 찾을 수 없습니다.');
    }
  });

  // 연결 해제
  socket.on('disconnect', () => {
    console.log('WebSocket 클라이언트 연결 해제됨');
  });
});

// 테스트 시작 함수
function startTest(clientId, dataSize, iterations) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  clientInfo.status = 'upload_testing';
  clientInfo.currentTest = {
    type: 'upload',
    dataSize: dataSize,
    iterations: iterations,
    currentIteration: 0,
    totalBytes: dataSize * iterations,
    receivedBytes: 0,
    startTime: Date.now(),
    results: []
  };

  // 첫 번째 업로드 테스트 시작
  startUploadTest(clientId);
}

// 업로드 테스트 시작
function startUploadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo || !clientInfo.currentTest) return;

  if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
    // 모든 업로드 테스트 완료
    clientInfo.status = 'upload_completed';
    clientInfo.webSocket.emit('testCompleted', {
      type: 'upload',
      results: clientInfo.currentTest.results
    });
    return;
  }

  clientInfo.currentTest.currentIteration++;
  clientInfo.currentTest.startTime = Date.now();

  // 랜덤 데이터 생성 및 전송
  const randomData = Buffer.alloc(clientInfo.currentTest.dataSize);
  for (let i = 0; i < clientInfo.currentTest.dataSize; i++) {
    randomData[i] = Math.floor(Math.random() * 256);
  }

  clientInfo.socket.write(randomData);
  
  io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
}

// 다운로드 테스트 시작 함수
function startDownloadTest(clientId, dataSize) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  clientInfo.status = 'download_testing';
  clientInfo.currentTest = {
    type: 'download',
    dataSize: dataSize,
    iterations: 5, // 기본 5회 반복
    currentIteration: 0,
    startTime: Date.now(),
    results: []
  };

  // 첫 번째 다운로드 테스트 시작
  startSingleDownloadTest(clientId);
}

// 단일 다운로드 테스트 시작
function startSingleDownloadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo || !clientInfo.currentTest) return;

  if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
    // 모든 다운로드 테스트 완료
    clientInfo.status = 'download_completed';
    clientInfo.webSocket.emit('testCompleted', {
      type: 'download',
      results: clientInfo.currentTest.results
    });
    return;
  }

  clientInfo.currentTest.currentIteration++;
  clientInfo.currentTest.startTime = Date.now();

  // 랜덤 데이터 생성 및 전송
  const randomData = Buffer.alloc(clientInfo.currentTest.dataSize);
  for (let i = 0; i < clientInfo.currentTest.dataSize; i++) {
    randomData[i] = Math.floor(Math.random() * 256);
  }

  clientInfo.socket.write(randomData);
  
  // 진행률 업데이트
  const progress = (clientInfo.currentTest.currentIteration / clientInfo.currentTest.iterations) * 100;
  clientInfo.webSocket.emit('testProgress', { type: 'download', progress, speed: 0 });
  
  io.emit('clientListUpdate', Array.from(serverState.connectedClients.values()));
}

// 테스트 결과 저장 함수
function saveTestResult(clientId, testType, dataSize, transferTime, speed) {
  const timestamp = new Date().toISOString();
  const clientInfo = serverState.connectedClients.get(clientId);
  
  const result = {
    timestamp,
    clientIP: clientInfo.ip,
    testType,
    dataSize,
    transferTime,
    speed,
    status: 'Success'
  };

  // 결과를 메모리에 저장
  if (!serverState.testResults.has(clientId)) {
    serverState.testResults.set(clientId, []);
  }
  serverState.testResults.get(clientId).push(result);

  // CSV 파일로 저장
  const filename = `network_test_${timestamp.replace(/[:.]/g, '-')}_${clientInfo.ip.replace(/\./g, '-')}.csv`;
  const csvContent = generateCSV(result);
  
  fs.writeFileSync(path.join(__dirname, 'results', filename), csvContent);
  console.log(`테스트 결과 저장됨: ${filename}`);
}

// CSV 생성 함수
function generateCSV(result) {
  const headers = 'Timestamp,ClientIP,TestType,DataSize(Bytes),TransferTime(ms),Speed(MB/s),Status\n';
  const row = `${result.timestamp},${result.clientIP},${result.testType},${result.dataSize},${result.transferTime},${result.speed.toFixed(2)},${result.status}\n`;
  return headers + row;
}

// 결과 디렉토리 생성
const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir);
}

// API 라우트
app.get('/api/server-info', (req, res) => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let ip = 'localhost';
  
  // 첫 번째 외부 IP 주소 찾기
  for (const name of Object.keys(interfaces)) {
    for (const interface of interfaces[name]) {
      if (interface.family === 'IPv4' && !interface.internal) {
        ip = interface.address;
        break;
      }
    }
    if (ip !== 'localhost') break;
  }
  
  res.json({ ip, tcpPort: serverState.tcpPort });
});

app.get('/api/results/:clientId', (req, res) => {
  const { clientId } = req.params;
  const results = serverState.testResults.get(clientId) || [];
  res.json(results);
});

app.get('/api/download/:clientId', (req, res) => {
  const { clientId } = req.params;
  const results = serverState.testResults.get(clientId) || [];
  
  if (results.length === 0) {
    return res.status(404).json({ error: '결과를 찾을 수 없습니다.' });
  }

  const filename = `network_test_${clientId.replace(/[:.]/g, '-')}.csv`;
  const csvContent = generateFullCSV(results);
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvContent);
});

function generateFullCSV(results) {
  const headers = 'Timestamp,ClientIP,TestType,DataSize(Bytes),TransferTime(ms),Speed(MB/s),Status\n';
  const rows = results.map(result => 
    `${result.timestamp},${result.clientIP},${result.testType},${result.dataSize},${result.transferTime},${result.speed.toFixed(2)},${result.status}`
  ).join('\n');
  return headers + rows;
}

// 서버 시작
const PORT = process.env.PORT || 8331;
const HOST = process.env.HOST || '0.0.0.0'; // 모든 IP에서 접속 허용

server.listen(PORT, HOST, () => {
  console.log(`웹 서버가 ${HOST}:${PORT}에서 실행 중입니다.`);
  console.log(`내부 접속: http://localhost:${PORT}`);
  console.log(`외부 접속: http://[서버IP]:${PORT}`);
});
