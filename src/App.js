import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  addDoc,
  serverTimestamp,
  getDocs,
} from 'firebase/firestore';

// Check for existing global Firebase instances first to avoid re-initialization warnings
let firebaseApp;
let db;
let auth;

const firebaseConfig = typeof window !== 'undefined' && window.firebaseConfig ? window.firebaseConfig : {};
const appId = typeof window !== 'undefined' && window.appId ? window.appId : 'default-app-id';

if (Object.keys(firebaseConfig).length > 0 && typeof window !== 'undefined') {
  if (!getApps().length) {
    firebaseApp = initializeApp(firebaseConfig);
    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);
  } else {
    firebaseApp = getApps()[0];
    db = getFirestore(firebaseApp);
    auth = getAuth(firebaseApp);
  }
} else {
  console.warn("Firebase config is empty or not running in a browser. App may not function correctly without Firebase. Ensure window.firebaseConfig is set in public/index.html.");
}

let localStream;
let remoteStream;
let peerConnection;

function App() {
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [currentView, setCurrentView] = useState('login');
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [roomUsers, setRoomUsers] = useState({}); // Tracks users currently in the room (keyed by userName)
  const [myUserId, setMyUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [modalMessage, setModalMessage] = useState('');
  const [callInitiatorId, setCallInitiatorId] = useState(null);
  const [isCalling, setIsCalling] = useState(false); // True when a call is being dialed or received
  const [isCallActive, setIsCallActive] = useState(false); // True when WebRTC connection is established and streams are active
  const [isLocalVideoMuted, setIsLocalVideoMuted] = useState(false); // State for local video mute button
  const [isLocalAudioMuted, setIsLocalAudioMuted] = useState(false); // State for local audio mute button
  const [callTimer, setCallTimer] = useState(0); // Timer for active video call duration
  const callTimerRef = useRef(null); // Ref to store interval ID for call timer
  const presenceIntervalRef = useRef(null); // Ref to store interval ID for presence updates

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const messagesEndRef = useRef(null);

  // eslint-disable-next-line
  useEffect(() => {
    if (callInitiatorId) {
      // console.log('Call initiated by:', callInitiatorId); // Keeping this commented out as it's not strictly necessary for functionality
    }
  }, [callInitiatorId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const showCustomModal = useCallback((message) => {
    setModalMessage(message);
    setShowModal(true);
  }, []);

  const closeCustomModal = useCallback(() => {
    setShowModal(false);
    setModalMessage('');
  }, []);

  const updatePresence = useCallback(async (currentRoomId, currentUserName, currentMyUserId, status) => {
    if (!db || !currentUserName || !currentMyUserId) {
        console.warn(`[Presence] Skipping updatePresence for user ${currentUserName} (${currentMyUserId}) status ${status}: DB, UserName, or UserID not ready.`);
        return;
    }

    const roomDocRef = doc(db, `artifacts/${appId}/public/data/rooms`, currentRoomId);
    const userStatusRef = doc(roomDocRef, 'users', currentUserName); // Keyed by userName

    try {
      if (status === 'online') {
        // Set presence and also set up onDisconnect to remove it on client disconnect
        await setDoc(userStatusRef, { 
            userName: currentUserName, 
            firebaseUid: currentMyUserId, 
            lastSeen: serverTimestamp() 
        });
        console.log(`[Presence] User ${currentUserName} (${currentMyUserId}) set to online.`);
      } else if (status === 'offline') {
        // When going offline gracefully, delete the presence document keyed by userName
        await deleteDoc(userStatusRef);
        console.log(`[Presence] User ${currentUserName} (${currentMyUserId}) set to offline (deleted).`);
      }
    } catch (error) {
      console.error(`Error updating presence for ${currentUserName} (${currentMyUserId}) to ${status}:`, error);
    }
  }, []);

  useEffect(() => {
      // Only set up interval if in chat view, and necessary Firebase/user details are available
      if (currentView === 'chat' && myUserId && roomId && userName && isAuthReady) {
          console.log(`[PresenceInterval] Setting up periodic presence update for ${userName} (${myUserId}) in room ${roomId}`);
          if (presenceIntervalRef.current) {
              clearInterval(presenceIntervalRef.current);
          }

          presenceIntervalRef.current = setInterval(() => {
              if (db && roomId && myUserId && userName) { 
                  updatePresence(roomId, userName, myUserId, 'online');
              }
          }, 15 * 1000); // Update every 15 seconds

          return () => {
              if (presenceIntervalRef.current) {
                  console.log(`[PresenceInterval] Clearing periodic presence update for ${userName} (${myUserId})`);
                  clearInterval(presenceIntervalRef.current);
                  presenceIntervalRef.current = null;
              }
          };
      } else {
          if (presenceIntervalRef.current) {
              console.log("[PresenceInterval] Clearing interval due to view change or dependencies not ready.");
              clearInterval(presenceIntervalRef.current);
              presenceIntervalRef.current = null;
          }
      }
  }, [currentView, myUserId, roomId, userName, isAuthReady, updatePresence]);


  const hangupCall = useCallback(async () => {
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
      remoteStream = null;
    }

    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      setCallTimer(0);
    }

    if (db && roomId && myUserId) {
      try {
        const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
        const otherUserPresence = Object.values(roomUsers).find(user => user.firebaseUid !== myUserId);
        const otherUserId = otherUserPresence ? otherUserPresence.firebaseUid : null;

        const myCandidatesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState/${myUserId}/candidates`);
        const myCandidatesSnapshot = await getDocs(myCandidatesCollectionRef);
        myCandidatesSnapshot.forEach(async (candidateDoc) => {
          await deleteDoc(candidateDoc.ref);
        });

        if (otherUserId) {
            const otherCandidatesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState/${otherUserId}/candidates`);
            const otherCandidatesSnapshot = await getDocs(otherCandidatesCollectionRef);
            otherCandidatesSnapshot.forEach(async (candidateDoc) => {
              await deleteDoc(candidateDoc.ref);
            });
        }
        await deleteDoc(callDocRef);
      } catch (error) {
        console.error("Error clearing call state in Firestore:", error);
      }
    }

    setIsCalling(false);
    setIsCallActive(false);
    setCallInitiatorId(null);
    setIsLocalVideoMuted(false);
    setIsLocalAudioMuted(false);
    setCurrentView('chat');
  }, [roomId, myUserId, roomUsers, setIsCalling, setIsCallActive, setCallInitiatorId, setIsLocalVideoMuted, setIsLocalAudioMuted, setCurrentView]);

  useEffect(() => {
    if (!auth) {
      console.error("Firebase Auth not initialized. Check firebaseConfig in public/index.html.");
      return;
    }

    const unsubscribeAuth = onAuthStateChanged(auth, async (user) => {
      if (user) {
        setMyUserId(user.uid);
        console.log("Firebase Auth Ready. User ID:", user.uid);
      } else {
        try {
          await signInAnonymously(auth);
          console.log("Signed in anonymously.");
        } catch (error) {
          console.error("Firebase anonymous sign-in failed:", error);
          showCustomModal(`Firebase sign-in failed: ${error.message}`);
        }
      }
      setIsAuthReady(true);
    });

    return () => {
      unsubscribeAuth();
    };
  }, [roomId, myUserId, userName, showCustomModal]);

  useEffect(() => {
    if (!roomId || !userName || !isAuthReady || !db) { 
        console.log("[RoomUsersEffect] Skipping onSnapshot setup: RoomID, UserName, Auth, or DB not ready.");
        return;
    }

    const roomUsersRef = collection(db, `artifacts/${appId}/public/data/rooms`, roomId, 'users');
    const q = query(roomUsersRef);

    console.log(`[RoomUsersEffect] Setting up onSnapshot for room: ${roomId} with query (users keyed by userName):`, q);
    const unsubscribe = onSnapshot(q, async (snapshot) => {
      const currentUsersData = {};
      snapshot.forEach((doc) => {
        currentUsersData[doc.id] = doc.data(); 
      });

      console.log(`[RoomUsersEffect] onSnapshot received ${snapshot.docs.length} user documents.`);
      console.log("[RoomUsersEffect] Current snapshot usersData:", currentUsersData);
      console.log("[RoomUsersEffect] Previous roomUsers state:", roomUsers);

      setRoomUsers(currentUsersData); 
    }, (error) => {
      console.error("[RoomUsersEffect] Error fetching room users:", error);
    });

    return () => {
        console.log(`[RoomUsersEffect] Unsubscribing from room users for room: ${roomId}`);
        unsubscribe();
    };
  }, [roomId, userName, isAuthReady, roomUsers]);

  const handleJoinRoom = async () => {
    if (!roomId.trim() || !userName.trim()) {
      showCustomModal("Please enter both Room Code and User Name.");
      return;
    }
    if (!isAuthReady || !myUserId || !db) {
      showCustomModal("Firebase is not ready. Please wait a moment.");
      return;
    }

    const roomDocRef = doc(db, `artifacts/${appId}/public/data/rooms`, roomId);
    const usersCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms`, roomId, 'users');

    try {
      const roomDoc = await getDoc(roomDocRef);
      if (!roomDoc.exists()) {
        await setDoc(roomDocRef, {
          name: roomId,
          createdAt: serverTimestamp(),
        });
        console.log(`[JoinRoom] Room ${roomId} created.`);
      }

      const now = Date.now();
      const STALE_THRESHOLD_MS = 45 * 1000; // 45 seconds (3 times the 15-second update interval)
      
      let usersSnapshotPreCleanup = await getDocs(usersCollectionRef);
      console.log(`[JoinRoom] Initial user check (before stale cleanup): Found ${usersSnapshotPreCleanup.docs.length} documents.`);
      
      const usersToDeletePromises = [];
      let isTargetUsernameTakenByAnother = false;

      for (const userDoc of usersSnapshotPreCleanup.docs) {
          const docUserName = userDoc.id;
          const userData = userDoc.data();
          const lastSeenMs = userData.lastSeen ? userData.lastSeen.toDate().getTime() : 0;
          
          const isStale = (now - lastSeenMs > STALE_THRESHOLD_MS || !userData.lastSeen);
          
          if (docUserName === userName.trim()) {
              if (isStale) {
                  console.warn(`[JoinRoom] Deleting stale presence for current userName: ${docUserName} (Last Seen: ${new Date(lastSeenMs).toLocaleString()}). Age: ${((now - lastSeenMs)/1000).toFixed(1)}s`);
                  usersToDeletePromises.push(deleteDoc(userDoc.ref).catch(e => console.error(`Failed to delete stale presence for current userName ${docUserName}:`, e)));
              } else {
                  if (userData.firebaseUid !== myUserId) {
                      console.warn(`[JoinRoom] Username '${docUserName}' is already taken by active user with different Firebase UID: ${userData.firebaseUid}. Blocking join.`);
                      isTargetUsernameTakenByAnother = true; 
                  } else {
                      console.log(`[JoinRoom] Rejoining as existing user ${docUserName} (${myUserId}).`);
                  }
              }
          } else if (isStale) {
              console.warn(`[JoinRoom] Deleting stale user: ${docUserName} (Last Seen: ${lastSeenMs ? new Date(lastSeenMs).toLocaleString() : 'N/A'}). Age: ${((now - lastSeenMs)/1000).toFixed(1)}s`);
              usersToDeletePromises.push(deleteDoc(userDoc.ref).catch(e => console.error(`Failed to delete stale user ${docUserName}:`, e)));
          } else {
              console.log(`[JoinRoom] User ${docUserName} is NOT stale or is current user (different username).`);
          }
      }
      await Promise.allSettled(usersToDeletePromises); 
      console.log(`[JoinRoom] Completed stale user cleanup.`);

      if (isTargetUsernameTakenByAnother) {
        showCustomModal(`The username '${userName.trim()}' is already taken by an active user in this room. Please choose a different name.`);
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 300)); 
      const usersSnapshotAfterCleanup = await getDocs(usersCollectionRef);
      const existingUsernamesAfterCleanup = usersSnapshotAfterCleanup.docs.map(doc => doc.id);
      
      console.log(`[JoinRoom] Post-cleanup check: Found ${existingUsernamesAfterCleanup.length} user documents (unique usernames) in room '${roomId}'.`);
      console.log(`[JoinRoom] Post-cleanup check: All usernames found: ${existingUsernamesAfterCleanup.join(', ')}`);

      if (existingUsernamesAfterCleanup.length >= 2) {
        showCustomModal("This room is full. Only two unique usernames allowed. Please try another room code or wait for a spot to open.");
        console.warn(`[JoinRoom] Room ${roomId} is full. Blocking join. Current active usernames found: ${existingUsernamesAfterCleanup.length}`);
        return; 
      }

      await updatePresence(roomId, userName.trim(), myUserId, 'online');
      console.log(`[JoinRoom] User ${userName} (${myUserId}) presence set to online after capacity and cleanup checks.`);
      
      setCurrentView('chat');
      console.log(`[JoinRoom] Successfully joined room ${roomId}.`);

    } catch (error) {
      console.error("[JoinRoom] Error joining room (caught in handleJoinRoom):", error);
      showCustomModal(`Failed to join room: ${error.message}`);
    }
  };

  const handleLeaveRoom = async () => {
    if (isCallActive) {
      await hangupCall();
    }

    try {
      if (myUserId && roomId && userName) {
        await updatePresence(roomId, userName, myUserId, 'offline');
      }
    } catch (error) {
        console.error("[LeaveRoom] Error during leave process:", error);
    } finally {
        setRoomId('');
        setUserName('');
        setMessages([]);
        setRoomUsers({}); 
        setCurrentView('login');
        setIsCalling(false);
        setIsCallActive(false);
        setCallInitiatorId(null);
        if (localStream) {
          localStream.getTracks().forEach(track => track.stop());
          localStream = null;
        }
        if (remoteStream) {
          remoteStream.getTracks().forEach(track => track.stop());
          remoteStream = null;
        }
        if (peerConnection) {
          peerConnection.close();
          peerConnection = null;
        }
        if (callTimerRef.current) {
          clearInterval(callTimerRef.current);
          setCallTimer(0);
        }
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    if (!db || !roomId || !myUserId || !userName) {
      showCustomModal("Chat not ready. Please try again.");
      return;
    }

    try {
      const messagesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/messages`);
      await addDoc(messagesCollectionRef, {
        senderId: myUserId,
        senderName: userName,
        text: newMessage,
        timestamp: serverTimestamp(),
      });
      setNewMessage('');
    } catch (error) {
      console.error("Error sending message:", error);
      showCustomModal(`Failed to send message: ${error.message}`);
    }
  };

  useEffect(() => {
    if (!db || !roomId || (currentView !== 'chat' && currentView !== 'videoCall') || !myUserId) return;

    const messagesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/messages`);
    const q = query(messagesCollectionRef, orderBy('timestamp'));

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedMessages = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setMessages(fetchedMessages);
    }, (error) => {
      console.error("Error fetching messages:", error);
    });

    return () => unsubscribe();
  }, [roomId, currentView, myUserId]);

  const servers = {
    iceServers: [
      { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    ],
    iceCandidatePoolSize: 10,
  };

  const createPeerConnection = async () => {
    if (peerConnection) {
      peerConnection.close();
    }
    peerConnection = new RTCPeerConnection(servers);

    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    }

    peerConnection.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
        remoteStream = event.streams[0];
      }
    };

    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        const candidatesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState/${myUserId}/candidates`);
        await addDoc(candidatesCollectionRef, event.candidate.toJSON());
      }
    };

    peerConnection.onconnectionstatechange = (event) => {
      console.log('Peer connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        setIsCallActive(true);
        callTimerRef.current = setInterval(() => {
          setCallTimer(prevTime => prevTime + 1);
        }, 1000);
      } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
        showCustomModal("Video call disconnected.");
        hangupCall();
      }
    };

    peerConnection.onsignalingstatechange = (event) => {
      console.log('Signaling state:', peerConnection.signalingState);
    };
  };

  const startCall = async () => {
    const otherUserPresence = Object.values(roomUsers).find(user => user.firebaseUid !== myUserId);
    const otherUserId = otherUserPresence ? otherUserPresence.firebaseUid : null;

    if (!otherUserId) {
      showCustomModal("No other user in the room to call.");
      return;
    }
    if (isCalling || isCallActive) {
      showCustomModal("A call is already in progress or being set up.");
      return;
    }

    setIsCalling(true);
    setCallInitiatorId(myUserId);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }

      await createPeerConnection();

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
      await setDoc(callDocRef, {
        offer: {
          sdp: offer.sdp,
          type: offer.type,
        },
        callerId: myUserId,
        timestamp: serverTimestamp(),
        status: 'pending',
      });

      const unsubscribeAnswer = onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        if (data?.answer && !peerConnection.currentRemoteDescription && data.answererId === otherUserId) {
          const answerDescription = new RTCSessionDescription(data.answer);
          await peerConnection.setRemoteDescription(answerDescription);
          listenForRemoteIceCandidates(otherUserId, peerConnection);
          unsubscribeAnswer();
          setCurrentView('videoCall');
        } else if (data?.status === 'rejected' && data.answererId === otherUserId) {
            showCustomModal("Call rejected by the other user.");
            hangupCall();
        }
      }, (error) => {
        console.error("Error listening for answer:", error);
      });

      showCustomModal("Calling other user...");

    } catch (error) {
      console.error("Error starting call:", error);
      showCustomModal(`Failed to start video call: ${error.message}. Please ensure camera/microphone permissions are granted.`);
      setIsCalling(false);
      hangupCall();
    }
  };

  const acceptCall = async (offerData, callerId) => {
    setIsCalling(true);
    setCallInitiatorId(callerId);

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream;
      }

      await createPeerConnection();

      const offerDescription = new RTCSessionDescription(offerData);
      await peerConnection.setRemoteDescription(offerDescription);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
      await updateDoc(callDocRef, {
        answer: {
          sdp: answer.sdp,
          type: answer.type,
        },
        answererId: myUserId,
        status: 'active',
      });

      listenForRemoteIceCandidates(callerId, peerConnection);

      setCurrentView('videoCall');
    } catch (error) {
      console.error("Error accepting call:", error);
      showCustomModal(`Failed to accept video call: ${error.message}. Please ensure camera/microphone permissions are granted.`);
      setIsCalling(false);
      hangupCall();
    }
  };

  const rejectCall = async () => {
    if (db && roomId) {
      try {
        const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
        await updateDoc(callDocRef, { status: 'rejected', answererId: myUserId });
      } catch (error) {
        console.error("Error rejecting call:", error);
      }
    }
    setCurrentView('chat');
    setIsCalling(false);
  };


  const listenForRemoteIceCandidates = useCallback(async (remotePeerId, pc) => {
    if (!db || !roomId || !pc || !remotePeerId) return;

    const candidatesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState/${remotePeerId}/candidates`);

    const unsubscribeCandidates = onSnapshot(candidatesCollectionRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          if (pc && pc.remoteDescription) {
            pc.addIceCandidate(candidate).catch(e => console.error('Error adding received ICE candidate:', e));
          } else {
            console.warn('Received ICE candidate before remote description was set. Candidate will be added once remote description is available.');
          }
        }
      });
    }, (error) => {
      console.error("Error listening for ICE candidates:", error);
    });

    return () => unsubscribeCandidates();
  }, [roomId]);

  const toggleLocalVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled;
        setIsLocalVideoMuted(!track.enabled);
      });
    }
  };

  const toggleLocalAudio = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled;
        setIsLocalAudioMuted(!track.enabled);
      });
    }
  };

  const formatTime = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  if (!isAuthReady) {
    return (
      <div className="flex items-center justify-center min-h-[100dvh] bg-white">
        <p className="text-xl text-gray-700">Loading...</p>
      </div>
    );
  }

  const outerContainerClasses =
    currentView === 'login' || currentView === 'incomingCall' || currentView === 'videoCall'
      ? 'flex flex-col items-center justify-center min-h-[100dvh] bg-gray-50 font-sans antialiased' // Adjusted for videoCall to also center and have bg
      : 'flex flex-col min-h-[100dvh] bg-gray-50 font-sans antialiased'; 

  return (
    <div className={outerContainerClasses}>
      {/* Custom Modal for Alerts (conditionally rendered) */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded-lg shadow-xl text-center max-w-sm w-full mx-4">
            <p className="text-lg font-semibold text-gray-800 mb-4">{modalMessage}</p>
            <button
              onClick={closeCustomModal}
              className="px-6 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-200"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Login View (Based on provided index.html) */}
      {currentView === 'login' && (
        <div className="flex flex-col items-center justify-center min-h-[100dvh] bg-gradient-to-br from-blue-600 to-purple-700 w-full p-4 font-sans text-center">
            <div className="bg-white p-8 sm:p-10 rounded-2xl shadow-2xl w-full max-w-sm transform transition-all duration-300 ease-in-out hover:scale-105">
                <div className="app-logo flex justify-center mb-6">
                    <span className="material-symbols-outlined text-blue-600 text-8xl">person</span>
                </div>
                <h1 className="text-5xl font-extrabold text-gray-900 mb-2">Parichat</h1>
                <p className="text-base text-gray-600 font-medium mb-8">Seamlessly Connect. Chat & Video Call. Privately.</p>

                <form onSubmit={handleJoinRoom} className="login-form space-y-5">
                    <div className="input-group">
                        <input
                            type="text"
                            id="roomCode"
                            placeholder="Room Code"
                            required
                            className="w-full px-5 py-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400 text-base"
                            value={roomId}
                            onChange={(e) => setRoomId(e.target.value)}
                        />
                    </div>
                    <div className="input-group">
                        <input
                            type="text"
                            id="userName"
                            placeholder="User Name"
                            required
                            className="w-full px-5 py-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400 text-base"
                            value={userName}
                            onChange={(e) => setUserName(e.target.value)}
                        />
                    </div>
                    <button
                        type="submit"
                        className="join-button w-full bg-blue-600 text-white py-3 rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-300 text-xl font-bold uppercase tracking-wide shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                    >
                        JOIN ROOM
                    </button>
                </form>
                <p className="text-center text-gray-500 mt-6 text-xs">
                    Your anonymous ID: <span className="font-mono text-[0.6rem] select-all">{myUserId || 'N/A'}</span>
                </p>
            </div>
        </div>
      )}

      {/* Incoming Call Modal (Based on provided index.html) */}
      {currentView === 'incomingCall' && (
        <div className="call-modal incoming-call-modal fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50 p-4">
            <div className="modal-content bg-white p-8 rounded-2xl shadow-xl text-center max-w-sm w-full mx-auto transform scale-105 animate-pop-in">
                <h1 className="call-status-text text-gray-900 font-extrabold text-5xl mb-2">Incoming</h1>
                <h2 className="call-status-text text-gray-700 font-bold text-3xl mb-8">Video Call</h2>
                <div className="call-actions flex justify-center space-x-8 mt-8">
                    <button onClick={rejectCall} className="call-btn reject-btn flex flex-col items-center p-4 bg-red-500 rounded-full shadow-lg hover:bg-red-600 focus:outline-none focus:ring-4 focus:ring-red-400 transition duration-200 text-white">
                        <span className="material-symbols-outlined text-5xl mb-2">call_end</span>
                        <span className="text-lg font-semibold">Reject</span>
                    </button>
                    <button onClick={async () => {
                        const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
                        const callData = (await getDoc(callDocRef)).data();
                        if (callData && callData.offer) {
                            acceptCall(callData.offer, callData.callerId);
                        } else {
                            showCustomModal("No active call offer found to accept.");
                            setCurrentView('chat');
                        }
                    }} className="call-btn accept-btn flex flex-col items-center p-4 bg-green-500 rounded-full shadow-lg hover:bg-green-600 focus:outline-none focus:ring-4 focus:ring-green-400 transition duration-200 text-white">
                        <span className="material-symbols-outlined text-5xl mb-2">call</span>
                        <span className="text-lg font-semibold">Accept</span>
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Chat and Video Call Views (Based on provided index.html) */}
      {(currentView === 'chat' || currentView === 'videoCall') && (
        <div className="chat-container flex flex-col w-full max-w-full sm:max-w-md md:max-w-lg lg:max-w-xl h-[100dvh] bg-white rounded-lg shadow-xl overflow-hidden border border-gray-100 mx-auto">
          {/* Chat Header (Fixed Position) */}
          <header className="chat-header sticky top-0 z-20 bg-gradient-to-r from-blue-600 to-purple-700 text-white p-4 flex items-center justify-between shadow-md">
              <div className="room-info flex items-center space-x-3">
                  <span className="material-symbols-outlined user-avatar-header text-white text-4xl">person</span>
                  <div className="details flex flex-col">
                      <h2 id="roomDisplayName" className="text-xl font-bold">{`${roomId}`}</h2>
                      <p className="user-status text-sm font-medium flex items-center">
                          <span className={`status-dot h-2.5 w-2.5 rounded-full mr-2 ${Object.keys(roomUsers).length === 2 ? 'bg-green-400' : 'bg-yellow-400'}`}></span> 
                          <span id="connectedUsersCount">{Object.keys(roomUsers).length}</span> Connected
                      </p>
                  </div>
              </div>
              <div className="header-actions flex items-center space-x-4">
                  {isCallActive && ( // Show call timer only when call is active
                      <span className="call-timer text-md font-semibold text-white mr-2">
                          {formatTime(callTimer)}
                      </span>
                  )}
                  <span className="material-symbols-outlined video-call-icon text-white cursor-pointer hover:opacity-80 transition-opacity duration-200 text-3xl" id="videoCallBtn" onClick={startCall}>videocam</span>
                  <span className="material-symbols-outlined leave-room-icon text-white cursor-pointer hover:opacity-80 transition-opacity duration-200 text-3xl" id="leaveRoomBtn" onClick={handleLeaveRoom}>logout</span>
              </div>
          </header>

          {/* Chat Messages Area */}
          <main id="chatMessages" className="chat-messages flex-grow p-4 space-y-4 overflow-y-auto bg-white pt-20"> {/* Added pt-20 to push content below sticky header */}
              {messages.length === 0 && (
                <div className="flex-grow flex items-center justify-center text-gray-500">
                  <p>No messages yet. Start chatting!</p>
                </div>
              )}
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${msg.senderId === myUserId ? 'justify-end' : 'justify-start'}`}
                >
                  {/* System messages (e.g., "User Joined", "User Left") */}
                  {msg.senderId === 'system' ? (
                    <div className="text-center w-full">
                      <span className="text-xs text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                        {msg.text}
                      </span>
                    </div>
                  ) : (
                    // Regular chat messages
                    <div
                      className={`max-w-[75%] p-3 rounded-xl shadow-sm relative ${
                        msg.senderId === myUserId
                          ? 'bg-blue-500 text-white rounded-br-none self-end'
                          : 'bg-white text-gray-900 rounded-bl-none self-start border border-gray-200'
                      }`}
                    >
                      <p className="text-base break-words">{msg.text}</p>
                      <span className="text-xs text-gray-600 block text-right mt-1">
                        {msg.senderId === myUserId ? 'You' : msg.senderName} • {msg.timestamp?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
          </main>

          {/* Chat Footer (Fixed Position - Message Input) */}
          <footer className="chat-footer sticky bottom-0 z-20 bg-gray-100 p-4 border-t border-gray-200 flex items-center space-x-3">
              <label htmlFor="imageUpload" className="image-upload-label cursor-pointer text-gray-500 hover:text-gray-700 transition-colors duration-200 text-3xl">
                  <span className="material-symbols-outlined">add_photo_alternate</span>
                  <input type="file" id="imageUpload" accept="image/*" style={{ display: 'none' }} onChange={() => showCustomModal("Image upload is not yet implemented.")}/> {/* Added onChange for modal */}
              </label>
              <input
                  type="text"
                  id="messageInput"
                  placeholder="Type your message..."
                  autoComplete="off"
                  className="flex-grow px-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSendMessage(e)} // Allow sending message with Enter
              />
              <button id="sendMessageBtn" className="send-message-btn p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-200" onClick={handleSendMessage}>
                  <span className="material-symbols-outlined">send</span>
              </button>
          </footer>

          {/* Active Video Call View (Full Screen Overlay) */}
          {currentView === 'videoCall' && (
            <div id="activeCallView" className="call-modal active-call-view fixed inset-0 bg-black flex flex-col items-center justify-center z-30">
                <div id="callTimer" className="call-timer absolute top-4 left-1/2 -translate-x-1/2 bg-gray-900 bg-opacity-70 text-white px-4 py-2 rounded-full text-lg font-semibold z-40">
                    {formatTime(callTimer)}
                </div>
                <video id="remoteVideo" ref={remoteVideoRef} autoPlay playsInline className="remote-video w-full h-full object-cover"></video>
                <video id="localVideo" ref={localVideoRef} autoPlay playsInline muted className="local-video pip-video absolute bottom-4 right-4 w-1/3 h-1/4 max-w-[150px] max-h-[200px] rounded-lg overflow-hidden border-2 border-white shadow-lg object-cover"></video>
                
                <div className="call-controls absolute bottom-4 left-0 right-0 flex justify-center items-center bg-transparent z-40">
                    <button className={`control-btn p-4 rounded-full mx-3 text-white transition duration-200 text-4xl shadow-md hover:shadow-lg ${isLocalVideoMuted ? 'bg-red-600' : 'bg-gray-800 hover:bg-gray-700'}`} onClick={toggleLocalVideo}>
                        <span className="material-symbols-outlined">{isLocalVideoMuted ? 'videocam_off' : 'videocam'}</span>
                    </button>
                    <button className={`control-btn p-4 rounded-full mx-3 text-white transition duration-200 text-4xl shadow-md hover:shadow-lg ${isLocalAudioMuted ? 'bg-red-600' : 'bg-gray-800 hover:bg-gray-700'}`} onClick={toggleLocalAudio}>
                        <span className="material-symbols-outlined">{isLocalAudioMuted ? 'mic_off' : 'mic'}</span>
                    </button>
                    <button className="control-btn end-call-btn p-4 rounded-full bg-red-600 text-white mx-3 hover:bg-red-700 transition duration-200 text-4xl shadow-md hover:shadow-lg" onClick={hangupCall}>
                        <span className="material-symbols-outlined">call_end</span>
                    </button>
                </div>
            </div>
          )}

        </div>
      )}
    </div>
  );
}

export default App;
