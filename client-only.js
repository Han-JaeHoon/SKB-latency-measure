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

// 클라이언트 상태 관리
const clientState = {
  serverIP: '',
  serverPort: 48001,
  tcpSocket: null,
  isConnected: false,
  currentTest: null,
  testResults: []
};

// TCP 클라이언트 연결 함수
function connectToServer(serverIP, serverPort) {
  return new Promise((resolve, reject) => {
    console.log(`🔗 서버 연결 시도: ${serverIP}:${serverPort}`);
    
    const tcpClient = new net.Socket();
    
    // 연결 타임아웃 설정 (10초)
    const timeout = setTimeout(() => {
      console.log('⏰ 연결 타임아웃');
      tcpClient.destroy();
      reject(new Error('연결 타임아웃'));
    }, 10000);
    
    tcpClient.connect(serverPort, serverIP, () => {
      clearTimeout(timeout);
      console.log(`✅ 서버에 연결됨: ${serverIP}:${serverPort}`);
      clientState.tcpSocket = tcpClient;
      clientState.isConnected = true;
      clientState.serverIP = serverIP;
      clientState.serverPort = serverPort;
      resolve(tcpClient);
    });
    
    tcpClient.on('data', (data) => {
      // 서버로부터 받은 데이터 처리
      const dataStr = data.toString();
      
      if (dataStr === 'START_DOWNLOAD') {
        console.log('📥 서버로부터 다운로드 테스트 시작 신호 수신');
        startDownloadTest();
      } else {
        // 다운로드 테스트 데이터 처리
        handleDownloadData(data);
      }
    });
    
    tcpClient.on('close', () => {
      clearTimeout(timeout);
      console.log('🔴 서버 연결이 종료되었습니다.');
      clientState.isConnected = false;
      clientState.tcpSocket = null;
      io.emit('connectionStatus', { status: 'disconnected' });
    });
    
    tcpClient.on('error', (err) => {
      clearTimeout(timeout);
      console.error('❌ 서버 연결 오류:', err);
      console.error('   오류 코드:', err.code);
      console.error('   오류 메시지:', err.message);
      clientState.isConnected = false;
      clientState.tcpSocket = null;
      reject(err);
    });
  });
}

// 다운로드 데이터 처리
function handleDownloadData(data) {
  console.log(`📥 서버로부터 데이터 수신: ${data.length} bytes`);
  
  if (clientState.currentTest && clientState.currentTest.type === 'full_test') {
    const endTime = Date.now();
    const transferTime = endTime - clientState.currentTest.startTime;
    const speed = (data.length / 1024 / 1024) / (transferTime / 1000); // MB/s
    
    clientState.currentTest.downloadResults.push({
      dataSize: data.length,
      transferTime: transferTime,
      speed: speed
    });
    
    console.log(`📥 다운로드 테스트 완료 - 속도: ${speed.toFixed(2)} MB/s`);
    
    // 진행률 업데이트 (전체 테스트 기준)
    const totalProgress = (clientState.currentTest.currentIteration * 2) / (clientState.currentTest.iterations * 2) * 100;
    io.emit('testProgress', { type: 'download', progress: totalProgress, speed });
    
    // 현재 반복 완료, 다음 반복 또는 전체 완료
    if (clientState.currentTest.currentIteration >= clientState.currentTest.iterations) {
      console.log('✅ 모든 테스트 완료');
      io.emit('testCompleted', { 
        type: 'full_test', 
        uploadResults: clientState.currentTest.uploadResults,
        downloadResults: clientState.currentTest.downloadResults
      });
    } else {
      console.log(`⏳ 다음 반복 대기 중... (${clientState.currentTest.currentIteration + 1}/${clientState.currentTest.iterations})`);
      // 서버에 다운로드 완료 신호 전송
      clientState.tcpSocket.write(Buffer.from('DOWNLOAD_COMPLETE'));
    }
  } else {
    console.log('⚠️ 전체 테스트 중이 아닙니다. 현재 테스트:', clientState.currentTest ? clientState.currentTest.type : '없음');
  }
}

// 전체 테스트 시작
function startTest(dataSize, iterations) {
  if (!clientState.isConnected || !clientState.tcpSocket) {
    throw new Error('서버에 연결되지 않았습니다.');
  }
  
  clientState.currentTest = {
    type: 'full_test',
    dataSize: dataSize,
    iterations: iterations,
    currentIteration: 0,
    uploadResults: [],
    downloadResults: []
  };
  
  console.log(`🚀 전체 테스트 시작 - 데이터 크기: ${formatBytes(dataSize)}, 반복: ${iterations}회`);
  
  // 서버에 테스트 시작 요청 전송 (반복 횟수 포함)
  console.log(`📤 서버에 테스트 시작 요청 전송 (반복: ${iterations}회)`);
  clientState.tcpSocket.write(Buffer.from(`START_TEST:${iterations}`));
}

// 단일 업로드 테스트
function startSingleUploadTest() {
  if (!clientState.currentTest) return;
  
  clientState.currentTest.currentIteration++;
  const startTime = Date.now();
  
  // 랜덤 데이터 생성
  const randomData = Buffer.alloc(clientState.currentTest.dataSize);
  for (let i = 0; i < clientState.currentTest.dataSize; i++) {
    randomData[i] = Math.floor(Math.random() * 256);
  }
  
  // 데이터 전송
  clientState.tcpSocket.write(randomData);
  
  // 진행률 업데이트 (전체 테스트 기준)
  const totalProgress = (clientState.currentTest.currentIteration * 2) / (clientState.currentTest.iterations * 2) * 100;
  io.emit('testProgress', { type: 'upload', progress: totalProgress, speed: 0 });
  
  console.log(`📤 업로드 테스트 ${clientState.currentTest.currentIteration}/${clientState.currentTest.iterations}`);
}

// 다운로드 테스트 시작 (현재 반복의 다운로드)
function startDownloadTest() {
  if (!clientState.isConnected || !clientState.tcpSocket) {
    throw new Error('서버에 연결되지 않았습니다.');
  }
  
  console.log(`🚀 다운로드 테스트 시작 (${clientState.currentTest.currentIteration}/${clientState.currentTest.iterations})`);
  startSingleDownloadTest();
}

// 단일 다운로드 테스트
function startSingleDownloadTest() {
  if (!clientState.currentTest || clientState.currentTest.currentIteration >= clientState.currentTest.iterations) {
    // 모든 다운로드 테스트 완료
    console.log('✅ 모든 다운로드 테스트 완료');
    io.emit('testCompleted', { type: 'download', results: clientState.currentTest.results });
    return;
  }
  
  clientState.currentTest.currentIteration++;
  clientState.currentTest.startTime = Date.now();
  
  // 서버에 다운로드 요청 (간단한 프로토콜)
  const request = Buffer.from('DOWNLOAD_REQUEST');
  clientState.tcpSocket.write(request);
  
  // 진행률 업데이트
  const progress = (clientState.currentTest.currentIteration / clientState.currentTest.iterations) * 100;
  io.emit('testProgress', { type: 'download', progress, speed: 0 });
  
  console.log(`📥 다운로드 테스트 ${clientState.currentTest.currentIteration}/${clientState.currentTest.iterations}`);
}

// 바이트 단위 포맷팅
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// WebSocket 연결 처리
io.on('connection', (socket) => {
  console.log('🌐 웹 클라이언트 연결됨');
  
  // 현재 상태 전송
  socket.emit('clientState', {
    isConnected: clientState.isConnected,
    serverIP: clientState.serverIP,
    serverPort: clientState.serverPort
  });
  
  // 서버 연결 요청
  socket.on('connectToServer', async (data, callback) => {
    console.log('🌐 WebSocket에서 connectToServer 이벤트 수신:', data);
    const { serverIP, serverPort } = data;
    
    try {
      console.log('🔗 TCP 서버 연결 시도...');
      await connectToServer(serverIP, serverPort);
      console.log('✅ TCP 서버 연결 성공');
      
      // 성공 응답 전송
      if (callback) {
        callback({ success: true });
      }
      
      // 상태 업데이트 이벤트 전송
      socket.emit('connectionStatus', { status: 'connected' });
      socket.emit('clientState', {
        isConnected: true,
        serverIP: clientState.serverIP,
        serverPort: clientState.serverPort
      });
      
      console.log('📤 연결 성공 응답 전송 완료');
    } catch (error) {
      console.error('❌ TCP 서버 연결 실패:', error);
      
      // 실패 응답 전송
      if (callback) {
        callback({ success: false, error: error.message });
      }
      
      socket.emit('connectionStatus', { status: 'error', error: error.message });
    }
  });
  
  // 테스트 시작 요청
  socket.on('startTest', (data) => {
    const { dataSize, iterations } = data;
    
    try {
      startTest(dataSize, iterations);
      socket.emit('testStarted', { success: true });
    } catch (error) {
      socket.emit('testStarted', { success: false, error: error.message });
    }
  });
  
  // 연결 해제
  socket.on('disconnect', () => {
    console.log('🌐 웹 클라이언트 연결 해제됨');
  });
});

// API 라우트
app.get('/api/status', (req, res) => {
  res.json({
    isConnected: clientState.isConnected,
    serverIP: clientState.serverIP,
    serverPort: clientState.serverPort
  });
});

// 서버 시작
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('🚀 네트워크 속도 측정 클라이언트 시작');
  console.log(`🌐 웹 서버가 ${HOST}:${PORT}에서 실행 중입니다.`);
  console.log(`📱 브라우저에서 http://localhost:${PORT} 접속하세요.`);
  console.log(`🔗 서버 연결 대기 중...\n`);
});

// 종료 처리
process.on('SIGINT', () => {
  console.log('\n🛑 클라이언트를 종료합니다...');
  if (clientState.tcpSocket) {
    clientState.tcpSocket.destroy();
  }
  server.close(() => {
    console.log('✅ 클라이언트가 정상적으로 종료되었습니다.');
    process.exit(0);
  });
});
