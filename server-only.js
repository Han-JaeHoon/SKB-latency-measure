const net = require('net');
const fs = require('fs');
const path = require('path');

// 서버 상태 관리
const serverState = {
  tcpPort: 48001,
  connectedClients: new Map(), // clientId -> clientInfo
  testResults: new Map(), // clientId -> testResults
  isRunning: false
};

// 결과 디렉토리 생성
const resultsDir = path.join(__dirname, 'results');
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir);
}

// TCP 서버 생성
const tcpServer = net.createServer((socket) => {
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`\n🟢 TCP 클라이언트 연결: ${clientId}`);
  
  // 클라이언트 정보 저장
  serverState.connectedClients.set(clientId, {
    id: clientId,
    ip: socket.remoteAddress,
    port: socket.remotePort,
    status: 'connected',
    currentTest: null,
    uploadSpeed: 0,
    downloadSpeed: 0,
    connectTime: new Date()
  });

  // 연결된 클라이언트 목록 출력
  printClientList();

  socket.on('data', (data) => {
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
          
          console.log(`📊 업로드 테스트 완료 - ${clientId}`);
          console.log(`   데이터 크기: ${formatBytes(clientInfo.currentTest.dataSize)}`);
          console.log(`   전송 시간: ${transferTime}ms`);
          console.log(`   속도: ${speed.toFixed(2)} MB/s`);
          
          // 다음 테스트 또는 완료
          if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
            // 모든 업로드 테스트 완료
            clientInfo.status = 'upload_completed';
            clientInfo.uploadSpeed = speed;
            console.log(`✅ 모든 업로드 테스트 완료 - ${clientId}`);
            
            // 다운로드 테스트 시작
            startDownloadTest(clientId);
          } else {
            // 다음 업로드 테스트
            setTimeout(() => {
              startUploadTest(clientId);
            }, 1000);
          }
        }
      }
    }
  });

  socket.on('close', () => {
    console.log(`\n🔴 TCP 클라이언트 연결 해제: ${clientId}`);
    serverState.connectedClients.delete(clientId);
    printClientList();
  });

  socket.on('error', (err) => {
    console.error(`❌ TCP 클라이언트 오류: ${clientId}`, err);
    serverState.connectedClients.delete(clientId);
    printClientList();
  });
});

// 업로드 테스트 시작
function startUploadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  clientInfo.status = 'upload_testing';
  clientInfo.currentTest = {
    type: 'upload',
    dataSize: 1048576, // 1MB
    iterations: 5,
    currentIteration: 0,
    receivedBytes: 0,
    startTime: Date.now(),
    results: []
  };

  console.log(`🚀 업로드 테스트 시작 - ${clientId}`);
  startSingleUploadTest(clientId);
}

// 단일 업로드 테스트
function startSingleUploadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  const socket = getClientSocket(clientId);
  
  if (!clientInfo || !clientInfo.currentTest || !socket) return;

  if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
    return; // 모든 테스트 완료
  }

  clientInfo.currentTest.currentIteration++;
  clientInfo.currentTest.startTime = Date.now();
  clientInfo.currentTest.receivedBytes = 0;

  console.log(`📤 업로드 테스트 ${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations} - ${clientId}`);
}

// 다운로드 테스트 시작
function startDownloadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  clientInfo.status = 'download_testing';
  clientInfo.currentTest = {
    type: 'download',
    dataSize: 1048576, // 1MB
    iterations: 5,
    currentIteration: 0,
    startTime: Date.now(),
    results: []
  };

  console.log(`🚀 다운로드 테스트 시작 - ${clientId}`);
  startSingleDownloadTest(clientId);
}

// 단일 다운로드 테스트
function startSingleDownloadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  const socket = getClientSocket(clientId);
  
  if (!clientInfo || !clientInfo.currentTest || !socket) return;

  if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
    // 모든 다운로드 테스트 완료
    clientInfo.status = 'download_completed';
    console.log(`✅ 모든 다운로드 테스트 완료 - ${clientId}`);
    
    // 결과 저장
    saveTestResults(clientId);
    return;
  }

  clientInfo.currentTest.currentIteration++;
  clientInfo.currentTest.startTime = Date.now();

  // 랜덤 데이터 생성 및 전송
  const randomData = Buffer.alloc(clientInfo.currentTest.dataSize);
  for (let i = 0; i < clientInfo.currentTest.dataSize; i++) {
    randomData[i] = Math.floor(Math.random() * 256);
  }

  socket.write(randomData);
  
  console.log(`📥 다운로드 테스트 ${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations} - ${clientId}`);
}

// 클라이언트 소켓 가져오기 (간단한 구현)
function getClientSocket(clientId) {
  // 실제 구현에서는 소켓 객체를 저장해야 함
  // 여기서는 간단히 구현
  return null;
}

// 테스트 결과 저장
function saveTestResults(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `server_test_${timestamp}_${clientInfo.ip.replace(/\./g, '-')}.csv`;
  
  let csvContent = 'Timestamp,ClientIP,TestType,DataSize(Bytes),TransferTime(ms),Speed(MB/s),Status\n';
  
  // 업로드 결과
  if (clientInfo.currentTest && clientInfo.currentTest.results) {
    clientInfo.currentTest.results.forEach((result, index) => {
      csvContent += `${new Date().toISOString()},${clientInfo.ip},Upload ${index + 1},${result.dataSize},${result.transferTime},${result.speed.toFixed(2)},Success\n`;
    });
  }
  
  fs.writeFileSync(path.join(resultsDir, filename), csvContent);
  console.log(`💾 테스트 결과 저장됨: ${filename}`);
}

// 클라이언트 목록 출력
function printClientList() {
  console.log('\n📋 연결된 클라이언트 목록:');
  if (serverState.connectedClients.size === 0) {
    console.log('   연결된 클라이언트가 없습니다.');
  } else {
    serverState.connectedClients.forEach((client, clientId) => {
      const status = getStatusEmoji(client.status);
      const duration = Math.floor((new Date() - client.connectTime) / 1000);
      console.log(`   ${status} ${clientId} (${client.status}) - 연결 시간: ${duration}초`);
      if (client.uploadSpeed > 0) {
        console.log(`      업로드 속도: ${client.uploadSpeed.toFixed(2)} MB/s`);
      }
    });
  }
  console.log('');
}

// 상태 이모지 반환
function getStatusEmoji(status) {
  switch (status) {
    case 'connected': return '🟢';
    case 'upload_testing': return '🟡';
    case 'download_testing': return '🟠';
    case 'upload_completed': return '✅';
    case 'download_completed': return '🎉';
    default: return '⚪';
  }
}

// 바이트 단위 포맷팅
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// TCP 서버 시작
tcpServer.listen(serverState.tcpPort, () => {
  console.log('🚀 네트워크 속도 측정 서버 시작');
  console.log(`📡 TCP 서버가 포트 ${serverState.tcpPort}에서 실행 중입니다.`);
  console.log(`🌐 클라이언트 연결 대기 중...\n`);
  
  // 주기적으로 클라이언트 목록 출력
  setInterval(() => {
    if (serverState.connectedClients.size > 0) {
      printClientList();
    }
  }, 10000); // 10초마다
});

// 종료 처리
process.on('SIGINT', () => {
  console.log('\n🛑 서버를 종료합니다...');
  tcpServer.close(() => {
    console.log('✅ 서버가 정상적으로 종료되었습니다.');
    process.exit(0);
  });
});
