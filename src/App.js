import React, { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth'; // Removed signInWithCustomToken as it's not used for anonymous auth
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

// IMPORTANT: For direct GitHub file creation, we'll read Firebase config from window.firebaseConfig
// This assumes you will paste your actual Firebase config into public/index.html
const firebaseConfig = window.firebaseConfig || {};
const appId = window.appId || 'default-app-id'; // Assuming appId is also set in index.html for consistency

// Initialize Firebase services globally to ensure it's done only once.
let firebaseApp;
let db;
let auth;

// Initialize Firebase if config is available and not already initialized
if (Object.keys(firebaseConfig).length > 0 && !initializeApp.apps.length) {
  firebaseApp = initializeApp(firebaseConfig);
  db = getFirestore(firebaseApp);
  auth = getAuth(firebaseApp);
} else if (initializeApp.apps.length > 0) {
  // If already initialized (e.g., during hot-reloads in development), get existing instances
  firebaseApp = initializeApp.apps[0];
  db = getFirestore(firebaseApp);
  auth = getAuth(firebaseApp);
} else {
  // This warning will appear if firebaseConfig is not set in index.html
  console.warn("Firebase config is empty or Firebase not initialized. App may not function correctly. Please ensure window.firebaseConfig is set in public/index.html.");
}

// Global WebRTC variables for peer connection and streams.
// These are managed here for direct WebRTC API interaction,
// but their state and lifecycle are controlled by React component.
let localStream;
let remoteStream;
let peerConnection;

function App() {
  // State variables for UI and application logic
  const [roomId, setRoomId] = useState('');
  const [userName, setUserName] = useState('');
  const [currentView, setCurrentView] = useState('login'); // Controls which UI screen is visible
  const [messages, setMessages] = useState([]); // Stores chat messages
  const [newMessage, setNewMessage] = useState(''); // Input for new chat messages
  const [roomUsers, setRoomUsers] = useState({}); // Tracks users currently in the room
  const [myUserId, setMyUserId] = useState(null); // Current user's Firebase UID
  const [isAuthReady, setIsAuthReady] = useState(false); // Indicates if Firebase auth is initialized
  const [showModal, setShowModal] = useState(false); // Controls visibility of custom alert modal
  const [modalMessage, setModalMessage] = useState(''); // Message content for custom alert modal
  // `callInitiatorId` is used to track which user started the call for signaling purposes.
  const [callInitiatorId, setCallInitiatorId] = useState(null);
  const [isCalling, setIsCalling] = useState(false); // True when a call is being dialed or received
  const [isCallActive, setIsCallActive] = useState(false); // True when WebRTC connection is established and streams are active
  const [isLocalVideoMuted, setIsLocalVideoMuted] = useState(false); // State for local video mute button
  const [isLocalAudioMuted, setIsLocalAudioMuted] = useState(false); // State for local audio mute button
  const [callTimer, setCallTimer] = useState(0); // Timer for active video call duration
  const callTimerRef = useRef(null); // Ref to store interval ID for call timer

  // Refs for video elements to attach media streams
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  // Ref for auto-scrolling chat messages
  const messagesEndRef = useRef(null);

  // Effect to scroll to the bottom of the chat messages whenever messages array updates
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Function to smoothly scroll to the bottom of the chat container
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Effect for Firebase Authentication setup
  useEffect(() => {
    // Ensure auth object is available before proceeding
    if (!auth) {
      console.error("Firebase Auth not initialized. Check firebaseConfig in public/index.html.");
      return;
    }

    // Set up an authentication state change listener
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        // If a user is logged in, set their UID
        setMyUserId(user.uid);
        console.log("Firebase Auth Ready. User ID:", user.uid);
      } else {
        // If no user, attempt anonymous sign-in
        try {
          await signInAnonymously(auth);
          console.log("Signed in anonymously.");
        } catch (error) {
          console.error("Firebase anonymous sign-in failed:", error);
          showCustomModal(`Firebase sign-in failed: ${error.message}`);
        }
      }
      // Mark authentication as ready once the initial check is complete
      setIsAuthReady(true);
    });

    // Clean up the auth listener when the component unmounts
    return () => unsubscribe();
  }, []); // Empty dependency array means this runs once on mount. 'auth' is global and stable.

  // Utility function to display a custom modal alert
  const showCustomModal = (message) => {
    setModalMessage(message);
    setShowModal(true);
  };

  // Utility function to close the custom modal alert
  const closeCustomModal = () => {
    setShowModal(false);
    setModalMessage('');
  };

  // Function to update user's online/offline presence in Firestore
  // Removed 'db' and 'appId' from dependencies as they are globally stable and don't trigger re-renders
  const updatePresence = useCallback(async (currentRoomId, userId, userName, status) => {
    if (!db || !userId) return; // Ensure Firestore and user ID are available

    const roomDocRef = doc(db, `artifacts/${appId}/public/data/rooms`, currentRoomId);
    const userStatusRef = doc(roomDocRef, 'users', userId); // Reference to the user's presence document

    try {
      if (status === 'online') {
        // Set user's presence to online with their name and last seen timestamp
        await setDoc(userStatusRef, { userName: userName, lastSeen: serverTimestamp() });
        // Add a system message to the chat indicating the user joined
        await addDoc(collection(db, `artifacts/${appId}/public/data/rooms/${currentRoomId}/messages`), {
          senderId: 'system', // Special ID for system messages
          senderName: 'System',
          text: `${userName} Joined`,
          timestamp: serverTimestamp(),
        });
      } else if (status === 'offline') {
        // Delete the user's presence document when they go offline
        await deleteDoc(userStatusRef);
        // Add a system message to the chat indicating the user left
        await addDoc(collection(db, `artifacts/${appId}/public/data/rooms/${currentRoomId}/messages`), {
          senderId: 'system',
          senderName: 'System',
          text: `${userName} Left`,
          timestamp: serverTimestamp(),
        });
      }
    } catch (error) {
      console.error("Error updating presence:", error);
    }
  }, []); // Dependencies for this useCallback

  // Effect to listen for real-time updates on room users (presence)
  useEffect(() => {
    // Only set up listener if Firestore, roomId, and myUserId are available,
    // and the app is in a chat or video call view.
    if (!db || !roomId || (currentView !== 'chat' && currentView !== 'videoCall' && currentView !== 'incomingCall') || !myUserId) return;

    const roomUsersRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/users`);
    const q = query(roomUsersRef); // Query all users in the room's 'users' sub-collection

    // Set up real-time listener for user presence changes
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const usersData = {};
      snapshot.forEach((doc) => {
        usersData[doc.id] = doc.data(); // Populate usersData with user IDs and their data
      });
      setRoomUsers(usersData); // Update state with current room users
    }, (error) => {
      console.error("Error fetching room users:", error);
    });

    // Clean up the listener when the component unmounts or dependencies change
    return () => {
      unsubscribe();
      // Note: User offline status is handled in handleLeaveRoom for explicit control.
    };
  }, [roomId, currentView, myUserId, updatePresence]); // Removed 'db' and 'appId' from dependencies. Added updatePresence.


  // Function to handle joining a room
  const handleJoinRoom = async () => {
    // Validate input fields
    if (!roomId.trim() || !userName.trim()) {
      showCustomModal("Please enter both Room Code and User Name.");
      return;
    }
    // Ensure Firebase is ready
    if (!isAuthReady || !myUserId || !db) {
      showCustomModal("Firebase is not ready. Please wait a moment.");
      return;
    }

    const roomDocRef = doc(db, `artifacts/${appId}/public/data/rooms`, roomId);

    try {
      const roomDoc = await getDoc(roomDocRef);
      let existingUsersCount = 0;

      if (roomDoc.exists()) {
        // If room exists, count current active users
        const usersCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/users`);
        const usersSnapshot = await getDocs(usersCollectionRef);
        existingUsersCount = usersSnapshot.size;

        // Enforce 2-user limit
        if (existingUsersCount >= 2) {
          showCustomModal("This room is full. Please try another room code.");
          return;
        }
      } else {
        // If room does not exist, create it
        await setDoc(roomDocRef, {
          name: roomId, // Room name is the code itself
          createdAt: serverTimestamp(),
        });
      }

      // Update user's presence to 'online' in the room
      await updatePresence(roomId, myUserId, userName, 'online');

      // Transition to the chat view
      setCurrentView('chat');

    } catch (error) {
      console.error("Error joining room:", error);
      showCustomModal(`Failed to join room: ${error.message}`);
    }
  };

  // Function to handle leaving a room
  const handleLeaveRoom = async () => {
    if (isCallActive) {
      await hangupCall(); // End any active video call
    }

    if (myUserId && roomId) {
      await updatePresence(roomId, myUserId, userName, 'offline'); // Set user's presence to offline
    }
    // Reset all relevant state variables
    setRoomId('');
    setUserName('');
    setMessages([]);
    setRoomUsers({});
    setCurrentView('login'); // Return to login screen
    // Clear WebRTC related states and resources
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
    // Clear call timer
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      setCallTimer(0);
    }
  };

  // Function to handle sending a chat message
  const handleSendMessage = async (e) => {
    e.preventDefault(); // Prevent default form submission
    if (!newMessage.trim()) return; // Don't send empty messages

    // Ensure necessary data is available
    if (!db || !roomId || !myUserId || !userName) {
      showCustomModal("Chat not ready. Please try again.");
      return;
    }

    try {
      const messagesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/messages`);
      // Add the new message to Firestore
      await addDoc(messagesCollectionRef, {
        senderId: myUserId,
        senderName: userName,
        text: newMessage,
        timestamp: serverTimestamp(), // Use server timestamp for consistent ordering
      });
      setNewMessage(''); // Clear the input field
    } catch (error) {
      console.error("Error sending message:", error);
      showCustomModal(`Failed to send message: ${error.message}`);
    }
  };

  // Effect to listen for real-time chat messages
  useEffect(() => {
    // Only set up listener if Firestore, roomId, and myUserId are available,
    // and the app is in a chat or video call view.
    if (!db || !roomId || (currentView !== 'chat' && currentView !== 'videoCall') || !myUserId) return;

    const messagesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/messages`);
    // Query messages, ordering them by timestamp
    const q = query(messagesCollectionRef, orderBy('timestamp'));

    // Set up real-time listener for message changes
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedMessages = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data() // Include all document data
      }));
      setMessages(fetchedMessages); // Update state with new messages
    }, (error) => {
      console.error("Error fetching messages:", error);
    });

    // Clean up the listener when the component unmounts or dependencies change
    return () => unsubscribe();
  }, [roomId, currentView, myUserId]); // Removed 'db' and 'appId' from dependencies.

  // WebRTC servers configuration (STUN servers for NAT traversal)
  const servers = {
    iceServers: [
      { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    ],
    iceCandidatePoolSize: 10, // Number of ICE candidates to gather
  };

  // Function to create a new RTCPeerConnection instance
  const createPeerConnection = async () => {
    // Close any existing peer connection before creating a new one
    if (peerConnection) {
      peerConnection.close();
    }
    peerConnection = new RTCPeerConnection(servers);

    // Add local media stream tracks to the peer connection
    if (localStream) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
    }

    // Event handler for when a remote track is received
    peerConnection.ontrack = (event) => {
      if (remoteVideoRef.current && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0]; // Attach remote stream to video element
        remoteStream = event.streams[0]; // Store remote stream globally
      }
    };

    // Event handler for when ICE candidates are generated
    peerConnection.onicecandidate = async (event) => {
      if (event.candidate) {
        // Send generated ICE candidate to Firestore for signaling
        const candidatesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState/${myUserId}/candidates`);
        await addDoc(candidatesCollectionRef, event.candidate.toJSON());
      }
    };

    // Event handler for peer connection state changes
    peerConnection.onconnectionstatechange = (event) => {
      console.log('Peer connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'connected') {
        setIsCallActive(true); // Mark call as active
        // Start call timer
        callTimerRef.current = setInterval(() => {
          setCallTimer(prevTime => prevTime + 1);
        }, 1000);
      } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
        // If connection is lost, show alert and hang up
        showCustomModal("Video call disconnected.");
        hangupCall();
      }
    };

    // Event handler for signaling state changes
    peerConnection.onsignalingstatechange = (event) => {
      console.log('Signaling state:', peerConnection.signalingState);
    };
  };

  // Function to initiate a video call (Caller's side)
  const startCall = async () => {
    // Check if another user is present in the room
    const otherUserIds = Object.keys(roomUsers).filter(id => id !== myUserId);
    if (otherUserIds.length === 0) {
      showCustomModal("No other user in the room to call.");
      return;
    }
    // Prevent starting a call if one is already in progress or being set up
    if (isCalling || isCallActive) {
      showCustomModal("A call is already in progress or being set up.");
      return;
    }

    setIsCalling(true); // Indicate that a call is being initiated
    setCallInitiatorId(myUserId); // Set current user as the call initiator

    try {
      // Request access to local media (camera and microphone)
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream; // Display local video stream
      }

      await createPeerConnection(); // Create a new peer connection

      // Create an offer (SDP)
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer); // Set local description

      // Save the offer to Firestore for signaling
      const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
      await setDoc(callDocRef, {
        offer: {
          sdp: offer.sdp,
          type: offer.type,
        },
        callerId: myUserId,
        timestamp: serverTimestamp(),
        status: 'pending', // Set call status to pending
      });

      // Listen for the remote answer from Firestore
      const unsubscribeAnswer = onSnapshot(callDocRef, async (snapshot) => {
        const data = snapshot.data();
        // If an answer is received and not already set, and it's from the expected answerer
        if (data?.answer && !peerConnection.currentRemoteDescription && data.answererId === otherUserIds[0]) {
          const answerDescription = new RTCSessionDescription(data.answer);
          await peerConnection.setRemoteDescription(answerDescription); // Set remote description
          // Start listening for remote ICE candidates from the answerer
          listenForRemoteIceCandidates(otherUserIds[0], peerConnection);
          unsubscribeAnswer(); // Stop listening for this answer
          setCurrentView('videoCall'); // Transition to video call view
        } else if (data?.status === 'rejected' && data.answererId === otherUserIds[0]) {
            // If the other user rejected the call
            showCustomModal("Call rejected by the other user.");
            hangupCall(); // Clean up resources
        }
      }, (error) => {
        console.error("Error listening for answer:", error);
      });

      // Inform the user that the call is being initiated
      showCustomModal("Calling other user...");

    } catch (error) {
      console.error("Error starting call:", error);
      showCustomModal(`Failed to start video call: ${error.message}. Please ensure camera/microphone permissions are granted.`);
      setIsCalling(false); // Reset calling state
      hangupCall(); // Clean up if call initiation fails
    }
  };

  // Function to accept an incoming video call (Answerer's side)
  const acceptCall = async (offerData, callerId) => {
    setIsCalling(true); // Indicate that a call is being accepted
    setCallInitiatorId(callerId); // Set the caller's ID

    try {
      // Request access to local media
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream; // Display local video stream
      }

      await createPeerConnection(); // Create a new peer connection

      // Set the received remote offer description
      const offerDescription = new RTCSessionDescription(offerData);
      await peerConnection.setRemoteDescription(offerDescription);

      // Create an answer (SDP)
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer); // Set local description

      // Save the answer to Firestore
      const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
      await updateDoc(callDocRef, {
        answer: {
          sdp: answer.sdp,
          type: answer.type,
        },
        answererId: myUserId,
        status: 'active', // Update call status to active
      });

      // Start listening for remote ICE candidates from the caller
      listenForRemoteIceCandidates(callerId, peerConnection);

      setCurrentView('videoCall'); // Transition to video call view
    } catch (error) {
      console.error("Error accepting call:", error);
      showCustomModal(`Failed to accept video call: ${error.message}. Please ensure camera/microphone permissions are granted.`);
      setIsCalling(false); // Reset calling state
      hangupCall(); // Clean up if call acceptance fails
    }
  };

  // Function to reject an incoming video call
  const rejectCall = async () => {
    if (db && roomId) {
      try {
        const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
        // Update call status to 'rejected' in Firestore
        await updateDoc(callDocRef, { status: 'rejected', answererId: myUserId });
      } catch (error) {
        console.error("Error rejecting call:", error);
      }
    }
    setCurrentView('chat'); // Go back to chat view
    setIsCalling(false); // Reset calling state
  };

  // Function to hangup/end the video call
  const hangupCall = async () => {
    // Close peer connection if it exists
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    // Stop and clear local media stream tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
    // Clear remote media stream
    if (remoteStream) {
      remoteStream.getTracks().forEach(track => track.stop());
      remoteStream = null;
    }

    // Stop and clear call timer
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      setCallTimer(0);
    }

    // Clear call state in Firestore
    if (db && roomId) {
      try {
        const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
        // Delete all ICE candidates from both users involved in the call
        // We need to know who the other user is to clear their candidates too if they initiated.
        const otherUserId = Object.keys(roomUsers).find(id => id !== myUserId);

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
        await deleteDoc(callDocRef); // Delete the main call document
      } catch (error) {
        console.error("Error clearing call state in Firestore:", error);
      }
    }

    // Reset all call-related state variables
    setIsCalling(false);
    setIsCallActive(false);
    setCallInitiatorId(null);
    setIsLocalVideoMuted(false);
    setIsLocalAudioMuted(false);
    setCurrentView('chat'); // Return to chat view
  };

  // Effect to listen for incoming call offers or call state changes from Firestore
  // Removed 'db' and 'appId' from dependencies. Added `roomUsers` for re-evaluation when users change.
  useEffect(() => {
    // Only run if Firebase is ready and user is in a room
    if (!db || !roomId || !myUserId || !isAuthReady) return;

    const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');

    const unsubscribeCallState = onSnapshot(callDocRef, async (snapshot) => {
      const data = snapshot.data();
      if (data) {
        // If an offer exists, current user is not the caller, and no call is currently active/being set up by current user
        if (data.offer && data.callerId !== myUserId && !isCalling && !isCallActive) {
          // Ensure it's for a 2-user room and the other user is the caller, and call is still pending
          const otherUser = Object.keys(roomUsers).find(id => id !== myUserId);
          if (Object.keys(roomUsers).length === 2 && otherUser === data.callerId && data.status === 'pending') {
            setCurrentView('incomingCall'); // Switch to incoming call view
            setCallInitiatorId(data.callerId); // Store who initiated the call
          }
        } else if (data.status === 'rejected' && data.answererId !== myUserId && isCalling) {
            // If the other user rejected the call you initiated
            showCustomModal("Call rejected by the other user.");
            hangupCall();
        } else if (data.status === 'active' && data.callerId === myUserId && isCalling) {
             // If you are the caller and the call was accepted (status set to active by answerer)
             setCurrentView('videoCall'); // Switch to video call view
        }
      } else {
        // If the call document is deleted in Firestore, assume call ended by other user
        if (isCalling || isCallActive) {
          showCustomModal("Call ended by the other user.");
          hangupCall();
        }
      }
    }, (error) => {
      console.error("Error listening for call offers:", error);
    });

    // Clean up the listener when component unmounts or dependencies change
    return () => unsubscribeCallState();
  }, [roomId, myUserId, isAuthReady, isCalling, isCallActive, roomUsers, hangupCall, setCallInitiatorId]);


  // Callback function to listen for remote ICE candidates
  // Removed 'db' and 'appId' from dependencies.
  const listenForRemoteIceCandidates = useCallback(async (remotePeerId, pc) => {
    if (!db || !roomId || !pc || !remotePeerId) return;

    // Reference to the Firestore collection where the remote peer's candidates are stored
    const candidatesCollectionRef = collection(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState/${remotePeerId}/candidates`);

    // Set up real-time listener for remote ICE candidates
    const unsubscribeCandidates = onSnapshot(candidatesCollectionRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          // Only add candidate if remoteDescription is already set on the peer connection
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

    // Clean up the listener when component unmounts or dependencies change
    return () => unsubscribeCandidates();
  }, [roomId]); // Removed 'db' and 'appId' from dependencies.

  // Function to toggle local video stream on/off
  const toggleLocalVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => {
        track.enabled = !track.enabled; // Toggle track enabled state
        setIsLocalVideoMuted(!track.enabled); // Update UI state
      });
    }
  };

  // Function to toggle local audio stream on/off
  const toggleLocalAudio = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.enabled = !track.enabled; // Toggle track enabled state
        setIsLocalAudioMuted(!track.enabled); // Update UI state
      });
    }
  };

  // Utility function to format total seconds into MM:SS format for the call timer
  const formatTime = (totalSeconds) => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  // Display a loading message while Firebase authentication is being set up
  if (!isAuthReady) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900">
        <p className="text-xl text-gray-700 dark:text-gray-300">Loading...</p>
      </div>
    );
  }

  // Main render logic based on currentView state
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-100 dark:bg-gray-900 font-sans antialiased">
      {/* Custom Modal for Alerts (conditionally rendered) */}
      {showModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow-xl text-center max-w-sm w-full mx-4">
            <p className="text-lg font-semibold text-gray-800 dark:text-gray-200 mb-4">{modalMessage}</p>
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
        <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-700">
          <div className="flex flex-col items-center mb-8">
            {/* User Icon SVG */}
            <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-user-round text-blue-600 mb-4">
              <circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>
            </svg>
            <h1 className="text-4xl font-extrabold text-blue-600 mb-2">Parivideo</h1>
            <p className="text-lg text-gray-700 dark:text-gray-300 font-medium">Private Chat & Video Call</p>
          </div>
          <div className="mb-4">
            <label htmlFor="roomCode" className="sr-only">Room Code</label> {/* Accessible label */}
            <input
              type="text"
              id="roomCode"
              className="w-full px-5 py-3 border border-gray-300 dark:border-gray-700 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              placeholder="Room Code"
            />
          </div>
          <div className="mb-8">
            <label htmlFor="userName" className="sr-only">User Name</label> {/* Accessible label */}
            <input
              type="text"
              id="userName"
              className="w-full px-5 py-3 border border-gray-300 dark:border-gray-700 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
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
          <p className="text-center text-gray-600 dark:text-gray-400 mt-6 text-sm">
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
              {/* Phone Off Icon SVG */}
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-phone-off">
                <path d="M10.69 6.11 18.6 2.4a1 1 0 0 1 1.4 1.4L16.11 10.69"/><path d="M13.09 19.39 5.3 22.1a1 1 0 0 1-1.4-1.4l3.7-7.89"/><path d="M18.5 2.5 12 9 5.5 2.5"/><path d="m2 13 6 6 6-6"/><line x1="2" x2="22" y1="2" y2="22"/>
              </svg>
              <span className="mt-2 text-lg font-semibold">Reject</span>
            </button>
            <button
              onClick={async () => {
                // Fetch the latest call data to ensure we have the correct offer
                const callDocRef = doc(db, `artifacts/${appId}/public/data/rooms/${roomId}/callState`, 'currentCall');
                const callData = (await getDoc(callDocRef)).data();
                if (callData && callData.offer) {
                  acceptCall(callData.offer, callData.callerId);
                } else {
                  showCustomModal("No active call offer found to accept.");
                  setCurrentView('chat'); // Fallback to chat if no offer is found
                }
              }}
              className="flex flex-col items-center p-4 bg-green-500 rounded-full shadow-lg hover:bg-green-600 focus:outline-none focus:ring-4 focus:ring-green-400 transition duration-200"
              title="Accept Call"
            >
              {/* Phone Incoming Icon SVG */}
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
        <div className="flex flex-col w-full max-w-sm md:max-w-md lg:max-w-xl h-[95vh] bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-hidden border border-gray-200 dark:border-gray-700">
          {/* Chat Header (UI similar to 2.png) */}
          <div className="flex items-center justify-between p-4 bg-blue-600 text-white rounded-t-lg shadow-md">
            <div className="flex items-center space-x-3">
              {/* Profile Icon (Placeholder SVG) */}
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
              {/* Call Timer (only shown when call is active) */}
              {isCallActive && (
                 <span className="text-md font-semibold text-white mr-2">
                   {formatTime(callTimer)}
                 </span>
              )}
              {/* Start Video Call Button */}
              <button
                onClick={startCall}
                title="Start Video Call"
                className="p-2 rounded-full hover:bg-blue-700 transition duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
              >
                {/* Video Call Icon SVG */}
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-video">
                  <path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="8" width="14" height="8" rx="2"/>
                </svg>
              </button>
              {/* Leave Room Button */}
              <button
                onClick={handleLeaveRoom}
                title="Leave Room"
                className="p-2 rounded-full hover:bg-red-700 transition duration-200 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
              >
                {/* Leave Room Icon SVG */}
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-log-out">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="17 16 22 12 17 8"/><line x1="22" x2="10" y1="12" y2="12"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Chat Messages Area (UI similar to 2.png) */}
          <div className="flex-grow p-4 space-y-4 overflow-y-auto bg-gray-50 dark:bg-gray-700 custom-scrollbar relative">
            {messages.length === 0 && (
              <div className="flex-grow flex items-center justify-center text-gray-500 dark:text-gray-400">
                <p>No messages yet. Start chatting!</p>
              </div>
            )}
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.senderId === myUserId ? 'justify-end' : 'justify-start'}`}
              >
                {/* System messages (e.g., "User Joined") */}
                {msg.senderId === 'system' ? (
                  <div className="text-center w-full">
                    <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-600 px-3 py-1 rounded-full">
                      {msg.text}
                    </span>
                  </div>
                ) : (
                  // Regular chat messages
                  <div
                    className={`max-w-[75%] p-3 rounded-xl shadow-sm relative ${
                      msg.senderId === myUserId
                        ? 'bg-blue-500 text-white rounded-br-none self-end' // Your messages
                        : 'bg-gray-200 dark:bg-gray-600 text-gray-900 dark:text-white rounded-bl-none self-start' // Other user's messages
                    }`}
                  >
                    <p className="font-semibold text-sm mb-1">
                      {msg.senderId === myUserId ? 'You' : msg.senderName}
                    </p>
                    <p className="text-base break-words">{msg.text}</p>
                    <span className="text-xs text-gray-300 dark:text-gray-400 block text-right mt-1">
                      {msg.timestamp?.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} /> {/* Element for auto-scrolling to */}

            {/* Video Call Overlay (UI similar to 5.jpg) - Conditionally rendered */}
            {isCallActive && (
              <div className="absolute inset-0 bg-black bg-opacity-75 flex flex-col items-center justify-center z-10">
                <div className="relative w-full h-full flex flex-col items-center justify-center">
                  {/* Remote Video (Main display) */}
                  <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover"></video>
                  {/* Local Video (Small overlay) */}
                  <div className="absolute top-4 left-4 w-1/3 h-1/4 max-w-[120px] max-h-[160px] bg-gray-700 rounded-lg overflow-hidden shadow-lg border-2 border-white">
                    <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover"></video>
                  </div>

                  {/* Video Call Controls (UI similar to 4.jpg) */}
                  <div className="absolute bottom-4 left-0 right-0 flex justify-center items-center bg-transparent">
                    {/* Toggle Local Video Button */}
                    <button
                      onClick={toggleLocalVideo}
                      title={isLocalVideoMuted ? "Unmute Video" : "Mute Video"}
                      className={`p-3 rounded-full mx-2 ${isLocalVideoMuted ? 'bg-red-500' : 'bg-gray-700'} text-white hover:opacity-80 transition duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50`}
                    >
                      {/* Video On/Off Icons */}
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
                    {/* Toggle Local Audio Button */}
                    <button
                      onClick={toggleLocalAudio}
                      title={isLocalAudioMuted ? "Unmute Audio" : "Mute Audio"}
                      className={`p-3 rounded-full mx-2 ${isLocalAudioMuted ? 'bg-red-500' : 'bg-gray-700'} text-white hover:opacity-80 transition duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-opacity-50`}
                    >
                      {/* Mic On/Off Icons */}
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
                    {/* Hangup Call Button */}
                    <button
                      onClick={hangupCall}
                      title="End Call"
                      className="p-3 rounded-full bg-red-600 text-white mx-2 hover:bg-red-700 transition duration-200 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-opacity-50"
                    >
                      {/* Phone Off Icon SVG */}
                      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-phone-off">
                        <path d="M10.69 6.11 18.6 2.4a1 1 0 0 1 1.4 1.4L16.11 10.69"/><path d="M13.09 19.39 5.3 22.1a1 1 0 0 1-1.4-1.4l3.7-7.89"/><path d="M18.5 2.5 12 9 5.5 2.5"/><path d="m2 13 6 6 6-6"/><line x1="2" x2="22" y1="2" y2="22"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Chat Input (UI similar to 2.png) */}
          <form onSubmit={handleSendMessage} className="p-4 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center space-x-3">
              {/* Image Upload Icon (Non-functional placeholder SVG) */}
              <button type="button" className="p-2 rounded-full text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-image-plus">
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7"/><line x1="16" x2="22" y1="5" y2="5"/><line x1="19" x2="19" y1="2" y2="8"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>
                </svg>
              </button>
              <input
                type="text"
                className="flex-grow px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500"
                placeholder="Type your message..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
              />
              <button
                type="submit"
                className="p-3 bg-blue-600 text-white rounded-full hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 transition duration-200"
              >
                {/* Send Icon SVG */}
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
