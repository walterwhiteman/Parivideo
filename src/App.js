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
  const [isCalling, setIsCalling] = useState(false);
  const [isCallActive, setIsCallActive] = useState(false);
  const [isLocalVideoMuted, setIsLocalVideoMuted] = useState(false);
  const [isLocalAudioMuted, setIsLocalAudioMuted] = useState(false);
  const [callTimer, setCallTimer] = useState(0);
  const callTimerRef = useRef(null);
  const presenceIntervalRef = useRef(null);
  // Removed: isLocalPresenceUpdate ref as system messages are no longer generated

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const messagesEndRef = useRef(null);

  // eslint-disable-next-line
  useEffect(() => {
    if (callInitiatorId) {}
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
        await setDoc(userStatusRef, { 
          userName: currentUserName, 
          firebaseUid: currentMyUserId, 
          lastSeen: serverTimestamp() 
        });
        console.log(`[Presence] User ${currentUserName} (${currentMyUserId}) set to online.`);
      } else if (status === 'offline') {
        await deleteDoc(userStatusRef);
        console.log(`[Presence] User ${currentUserName} (${currentMyUserId}) set to offline (deleted).`);
      }
    } catch (error) {
      console.error(`Error updating presence for ${currentUserName} (${currentMyUserId}) to ${status}:`, error);
    }
  }, [db, appId]); // Added dependencies

  useEffect(() => {
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
  }, [currentView, myUserId, roomId, userName, isAuthReady, updatePresence, db]); // Added db to dependencies

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
  }, [roomId, myUserId, roomUsers, setIsCalling, setIsCallActive, setCallInitiatorId, setIsLocalVideoMuted, setIsLocalAudioMuted, setCurrentView, db, appId]); // Added dependencies

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
  }, [showCustomModal, auth]); // Removed roomId, userName, as they are not needed for auth state change listener

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
  }, [roomId, userName, isAuthReady, db, appId, roomUsers]); // Added db, appId to dependencies

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
  }, [roomId, currentView, myUserId, db, appId]); // Added db and appId to dependencies

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
          // The currentView won't change here, as videoCall is an overlay in this original structure.
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

      setCurrentView('chat'); // Remain in chat view, video call UI is handled as an overlay
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
  }, [roomId, db, appId]); // Added db, appId to dependencies

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

  useEffect(() => {
    if (!db || !roomId || !myUserId || currentView === 'login') return;

    const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');

    const unsubscribeCall = onSnapshot(callDocRef, async (snapshot) => {
      const callData = snapshot.data();
      if (callData && callData.status === 'pending' && callData.callerId !== myUserId && !isCalling && !isCallActive) {
        setCurrentView('incomingCall');
        setCallInitiatorId(callData.callerId);
      } else if (!callData && (currentView === 'incomingCall' || isCalling)) {
        console.log("Call document disappeared while waiting or calling.");
        if (isCalling) {
            showCustomModal("Call ended by other party or cancelled.");
        }
        hangupCall();
        setCurrentView('chat');
      } else if (callData && callData.status === 'rejected' && callData.answererId === myUserId) {
        console.log("Call rejected received or sent.");
        hangupCall();
        setCurrentView('chat');
      }
    }, (error) => {
      console.error("Error listening for call state:", error);
    });

    return () => unsubscribeCall();
  }, [db, roomId, myUserId, isCalling, isCallActive, currentView, showCustomModal, hangupCall, appId]); // Added appId to dependencies

  if (!isAuthReady) {
    return (
      <div className="flex items-center justify-center min-h-[100dvh] bg-white">
        <p className="text-xl text-gray-700">Loading...</p>
      </div>
    );
  }

  const outerContainerClasses =
    currentView === 'login' || currentView === 'incomingCall' || currentView === 'videoCall'
      ? 'flex flex-col items-center justify-center min-h-[100dvh] bg-white font-sans antialiased'
      : 'flex flex-col min-h-[100dvh] bg-white font-sans antialiased';

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

      {/* Login View (UI1.png) - Conditionally rendered */}
      {currentView === 'login' && (
        <div className="bg-white p-8 rounded-lg shadow-xl w-full max-w-md border border-gray-200">
          <div className="flex flex-col items-center mb-8">
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-user-round text-blue-600 mb-4">
              <circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>
            </svg>
            <h1 className="text-4xl font-extrabold text-blue-600 mb-2">Parivideo</h1>
            <p className="text-lg text-gray-900 font-medium">Private Chat & Video Call</p>
          </div>
          <div className="mb-4">
            <label htmlFor="roomCode" className="sr-only">Room Code</label>
            <input
              type="text"
              id="roomCode"
              className="w-full px-5 py-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Room Code"
            />
          </div>
          <div className="mb-8">
            <label htmlFor="userName" className="sr-only">User Name</label>
            <input
              type="text"
              id="userName"
              className="w-full px-5 py-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              placeholder="User Name"
            />
          </div>
          <button
            onClick={handleJoinRoom}
            className="w-full bg-blue-600 text-white py-3 rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-200 text-xl font-bold uppercase tracking-wide"
          >
            Join Room
          </button>
          <p className="text-center text-gray-600 mt-6 text-sm">
            Your anonymous ID: <span className="font-mono text-xs select-all">{myUserId || 'N/A'}</span>
          </p>
        </div>
      )}

      {/* Incoming Call View (3.png) - Conditionally rendered */}
      {currentView === 'incomingCall' && (
        <div className="fixed inset-0 bg-blue-600 flex flex-col items-center justify-between p-8 text-white z-40">
          <div className="text-center mt-16">
            <p className="text-2xl font-semibold mb-4">Incoming</p>
            <h1 className="text-5xl font-extrabold">Video Call</h1>
          </div>
          <div className="flex justify-center space-x-12 mb-20">
            <button
              onClick={rejectCall}
              className="flex flex-col items-center p-4 bg-red-500 rounded-full shadow-lg hover:bg-red-600 focus:outline-none focus:ring-4 focus:ring-red-400 transition duration-200"
              title="Reject Call"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-phone-off">
                <path d="M10.69 6.11 18.6 2.4a1 1 0 0 1 1.4 1.4L16.11 10.69"/><path d="M13.09 19.39 5.3 22.1a1 1 0 0 1-1.4-1.4l3.7-7.89"/><path d="M18.5 2.5 12 9 5.5 2.5"/><path d="m2 13 6 6 6-6"/><line x1="2" x2="22" y1="2" y2="22"/>
              </svg>
              <span className="mt-2 text-lg font-semibold">Reject</span>
            </button>
            <button
              onClick={async () => {
                const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
                const callData = (await getDoc(callDocRef)).data();
                if (callData && callData.offer) {
                  acceptCall(callData.offer, callData.callerId);
                } else {
                  showCustomModal("No active call offer found to accept.");
                  setCurrentView('chat');
                }
              }}
              className="flex flex-col items-center p-4 bg-green-500 rounded-full shadow-lg hover:bg-green-600 focus:outline-none focus:ring-4 focus:ring-green-400 transition duration-200"
              title="Accept Call"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-phone-incoming">
                <polyline points="16 2 16 8 22 8"/><line x1="16" x2="22" y1="8" y2="2"/><path d="M22 16.92v3.08a2 2 0 0 1-2 2A18.44 18.44 0 0 1 2 4a2 2 0 0 1 2-2h3.08L8.5 7.92A10.3 10.3 0 0 0 16 16z"/>
              </svg>
              <span className="mt-2 text-lg font-semibold">Accept</span>
            </button>
          </div>
        </div>
      )}


      {/* Chat and Video Call Views (2.png, 4.jpg, 5.jpg) - Conditionally rendered */}
      {(currentView === 'chat' || currentView === 'videoCall') && (
        <div className="flex flex-col flex-grow w-full max-w-full sm:max-w-sm md:max-w-md lg:max-w-xl h-[100dvh] bg-white rounded-lg shadow-xl overflow-hidden border border-gray-200">
          {/* Chat Header (UI similar to 2.png) - Fixed to top */}
          <div className="flex items-center justify-between p-4 bg-blue-600 text-white rounded-t-lg shadow-md sticky top-0 z-20">
            <div className="flex items-center space-x-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-user-circle">
                <circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"/>
              </svg>
              <div className="flex flex-col">
                <h2 className="text-xl font-bold">{`${roomId}`}</h2>
                <p className="text-sm font-medium flex items-center">
                  <span className={`h-2.5 w-2.5 rounded-full mr-2 ${Object.keys(roomUsers).length === 2 ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
                  {Object.keys(roomUsers).length} Connected
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              {isCallActive && (
                 <span className="text-md font-semibold text-white mr-2">
                   {formatTime(callTimer)}
                 </span>
              )}
              <button
                onClick={startCall}
                title="Start Video Call"
                className="p-2 rounded-full hover:bg-blue-700 transition duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-video">
                  <path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="8" width="14" height="8" rx="2"/>
                </svg>
              </button>
              <button
                onClick={handleLeaveRoom}
                title="Leave Room"
                className="p-2 rounded-full hover:bg-red-700 transition duration-200 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-log-out">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="17 16 22 12 17 8"/><line x1="22" x2="10" y1="12" y2="12"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Chat Messages Area - Scrolls */}
          <main id="chatMessages" className="flex-grow p-4 space-y-4 overflow-y-auto bg-white relative">
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

            {/* Video Call Overlay (UI similar to 5.jpg) - Conditionally rendered */}
            {isCallActive && (
              <div id="activeCallView" className="absolute inset-0 bg-black bg-opacity-75 flex flex-col items-center justify-center z-10">
                <div className="relative w-full h-full flex flex-col items-center justify-center">
                  {/* Remote Video (Main display) */}
                  <video id="remoteVideo" ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover"></video>
                  {/* Local Video (Small overlay) */}
                  <div className="absolute top-4 left-4 w-1/3 h-1/4 max-w-[120px] max-h-[160px] bg-blue-700 rounded-lg overflow-hidden shadow-lg border-2 border-white">
                    <video id="localVideo" ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover"></video>
                  </div>

                  {/* Video Call Controls (UI similar to 4.jpg) */}
                  <div className="absolute bottom-4 left-0 right-0 flex justify-center items-center bg-transparent">
                    <button
                      onClick={toggleLocalVideo}
                      title={isLocalVideoMuted ? "Unmute Video" : "Mute Video"}
                      className={`p-3 rounded-full mx-2 ${isLocalVideoMuted ? 'bg-red-500' : 'bg-blue-700'} text-white hover:opacity-80 transition duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50`}
                    >
                      {isLocalVideoMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-video-off">
                          <path d="M10.66 6.13 2 12v4a2 2 0 0 0 2 2h10.66"/><path d="M17 17.34 22 20V8a2 2 0 0 0-2-2H8.66"/><line x1="2" x2="22" y1="2" y2="22"/>
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-video">
                          <path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="8" width="14" height="8" rx="2"/>
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={toggleLocalAudio}
                      title={isLocalAudioMuted ? "Unmute Audio" : "Mute Audio"}
                      className={`p-3 rounded-full mx-2 ${isLocalAudioMuted ? 'bg-red-500' : 'bg-blue-700'} text-white hover:opacity-80 transition duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50`}
                    >
                      {isLocalAudioMuted ? (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-mic-off">
                          <line x1="2" x2="22" y1="2" y2="22"/><path d="M10 9v3a6 6 0 0 0 8.73 4.13"/><path d="M16 16v2a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2"/><path d="M9.36 5.86A7.63 7.63 0 0 0 9 12v1a3 3 0 0 0 5.12 2.12"/><line x1="12" x2="12" y1="19" y2="22"/>
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-mic">
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={hangupCall}
                      title="End Call"
                      className="p-3 rounded-full bg-red-600 text-white mx-2 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-phone-off">
                        <path d="M10.69 6.11 18.6 2.4a1 1 0 0 1 1.4 1.4L16.11 10.69"/><path d="M13.09 19.39 5.3 22.1a1 1 0 0 1-1.4-1.4l3.7-7.89"/><path d="M18.5 2.5 12 9 5.5 2.5"/><path d="m2 13 6 6 6-6"/><line x1="2" x2="22" y1="2" y2="22"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>

          {/* Chat Input (UI similar to 2.png) - Fixed to bottom */}
          <form onSubmit={handleSendMessage} className="p-4 bg-white border-t border-gray-200 sticky bottom-0 z-20">
            <div className="flex items-center space-x-3 w-full">
              <button
                type="button"
                onClick={() => showCustomModal("Image upload is not yet implemented.")}
                className="p-2 rounded-full text-gray-600 hover:bg-gray-100 focus:outline-none flex-shrink-0"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-image-plus">
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><line x1="16" x2="22" y1="5" y2="5"/><line x1="19" x2="19" y1="2" y2="8"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                </svg>
              </button>
              <input
                type="text"
                className="flex-grow px-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900 placeholder-gray-400"
                placeholder="Type your message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
              />
              <button
                type="submit"
                className="p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-200 flex-shrink-0"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-send">
                  <path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M9.3 9.3 17 17"/>
                </svg>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default App;
