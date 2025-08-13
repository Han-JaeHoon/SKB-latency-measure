const net = require('net');
const fs = require('fs');
const path = require('path');

// 서버 상태 관리
const serverState = {
  tcpPort: 48001,
  connectedClients: new Map(), // clientId -> clientInfo
  testResults: new Map(), // clientId -> testResults
  tcpSockets: new Map(), // clientId -> socket
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

  // 소켓 객체 저장
  serverState.tcpSockets.set(clientId, socket);

  // 연결된 클라이언트 목록 출력
  printClientList();

  socket.on('data', (data) => {
    const clientInfo = serverState.connectedClients.get(clientId);
    const dataStr = data.toString();
    
    // 테스트 시작 요청 확인
    if (dataStr.startsWith('START_TEST:')) {
      const iterations = parseInt(dataStr.split(':')[1]);
      console.log(`🚀 테스트 시작 요청 받음 - ${clientId} (반복: ${iterations}회)`);
      startFullTest(clientId, iterations);
      return;
    }
    
    // 다운로드 요청 확인
    if (dataStr === 'DOWNLOAD_REQUEST') {
      console.log(`📥 다운로드 요청 받음 - ${clientId}`);
      startDownloadTest(clientId);
      return;
    }
    
    // 다운로드 완료 신호 확인
    if (dataStr === 'DOWNLOAD_COMPLETE') {
      console.log(`📥 다운로드 완료 신호 받음 - ${clientId}`);
      handleDownloadComplete(clientId);
      return;
    }
    
    if (clientInfo && clientInfo.currentTest) {
      // 업로드 테스트 중인 경우
      if (clientInfo.currentTest.type === 'full_test' && clientInfo.status === 'upload_testing') {
        clientInfo.currentTest.receivedBytes += data.length;
        
        // 현재 반복 테스트 완료 체크
        if (clientInfo.currentTest.receivedBytes >= clientInfo.currentTest.dataSize) {
          const endTime = Date.now();
          const transferTime = endTime - clientInfo.currentTest.startTime;
          const speed = (clientInfo.currentTest.dataSize / 1024 / 1024) / (transferTime / 1000); // MB/s
          
          // 결과 저장
          clientInfo.currentTest.uploadResults.push({
            dataSize: clientInfo.currentTest.dataSize,
            transferTime: transferTime,
            speed: speed
          });
          
          console.log(`📊 업로드 테스트 완료 - ${clientId}`);
          console.log(`   데이터 크기: ${formatBytes(clientInfo.currentTest.dataSize)}`);
          console.log(`   전송 시간: ${transferTime}ms`);
          console.log(`   속도: ${speed.toFixed(2)} MB/s`);
          
          // 현재 반복의 업로드 완료, 다운로드 시작
          clientInfo.status = 'download_testing';
          console.log(`✅ 업로드 테스트 완료 - ${clientId} (${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations})`);
          console.log(`📤 클라이언트에 다운로드 테스트 시작 신호 전송`);
          
          // 클라이언트에 다운로드 테스트 시작 신호 전송
          const signal = Buffer.from('START_DOWNLOAD');
          socket.write(signal);
        }
      }
      
      // 다운로드 테스트 중인 경우 (클라이언트가 다운로드 완료 신호를 보냄)
      if (clientInfo && clientInfo.currentTest && clientInfo.currentTest.type === 'full_test' && clientInfo.status === 'download_testing') {
        console.log(`📥 다운로드 완료 신호 받음 - ${clientId} (${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations})`);
        
        // 현재 반복 완료, 다음 반복 또는 전체 완료
        if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
          // 모든 테스트 완료
          clientInfo.status = 'completed';
          console.log(`✅ 모든 테스트 완료 - ${clientId}`);
          
          // 결과 저장
          saveTestResults(clientId);
        } else {
          // 다음 반복 시작
          clientInfo.currentTest.currentIteration++;
          clientInfo.status = 'upload_testing';
          console.log(`🔄 다음 반복 시작 - ${clientId} (${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations})`);
          
          // 다음 반복의 업로드 테스트 시작
          setTimeout(() => {
            startSingleUploadTest(clientId);
          }, 1000);
        }
      }
    }
  });

  socket.on('close', () => {
    console.log(`\n🔴 TCP 클라이언트 연결 해제: ${clientId}`);
    serverState.connectedClients.delete(clientId);
    serverState.tcpSockets.delete(clientId);
    printClientList();
  });

  socket.on('error', (err) => {
    console.error(`❌ TCP 클라이언트 오류: ${clientId}`, err);
    serverState.connectedClients.delete(clientId);
    printClientList();
  });
});

// 전체 테스트 시작
function startFullTest(clientId, iterations) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  clientInfo.status = 'upload_testing';
  clientInfo.currentTest = {
    type: 'full_test',
    dataSize: 1048576, // 1MB
    iterations: iterations,
    currentIteration: 0,
    receivedBytes: 0,
    startTime: Date.now(),
    uploadResults: [],
    downloadResults: []
  };

  console.log(`🚀 전체 테스트 시작 - ${clientId} (반복: ${iterations}회)`);
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

// 다운로드 테스트 시작 (현재 반복의 다운로드)
function startDownloadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo) return;

  console.log(`🚀 다운로드 테스트 시작 - ${clientId} (${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations})`);
  startSingleDownloadTest(clientId);
}

// 단일 다운로드 테스트
function startSingleDownloadTest(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  const socket = getClientSocket(clientId);
  
  if (!clientInfo || !clientInfo.currentTest || !socket) return;

  clientInfo.currentTest.startTime = Date.now();

  // 랜덤 데이터 생성 및 전송
  const randomData = Buffer.alloc(clientInfo.currentTest.dataSize);
  for (let i = 0; i < clientInfo.currentTest.dataSize; i++) {
    randomData[i] = Math.floor(Math.random() * 256);
  }

  socket.write(randomData);
  
  console.log(`📥 다운로드 테스트 ${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations} - ${clientId}`);
}

// 클라이언트 소켓 가져오기
function getClientSocket(clientId) {
  return serverState.tcpSockets.get(clientId);
}

// 다운로드 완료 처리
function handleDownloadComplete(clientId) {
  const clientInfo = serverState.connectedClients.get(clientId);
  if (!clientInfo || !clientInfo.currentTest) return;
  
  console.log(`📥 다운로드 완료 처리 - ${clientId} (${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations})`);
  
  // 현재 반복 완료, 다음 반복 또는 전체 완료
  if (clientInfo.currentTest.currentIteration >= clientInfo.currentTest.iterations) {
    // 모든 테스트 완료
    clientInfo.status = 'completed';
    console.log(`✅ 모든 테스트 완료 - ${clientId}`);
    
    // 결과 저장
    saveTestResults(clientId);
  } else {
    // 다음 반복 시작
    clientInfo.currentTest.currentIteration++;
    clientInfo.status = 'upload_testing';
    console.log(`🔄 다음 반복 시작 - ${clientId} (${clientInfo.currentTest.currentIteration}/${clientInfo.currentTest.iterations})`);
    
    // 다음 반복의 업로드 테스트 시작
    setTimeout(() => {
      startSingleUploadTest(clientId);
    }, 1000);
  }
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
