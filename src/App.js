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
}, []);

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
}, [currentView, myUserId, roomId, userName, isAuthReady, updatePresence]);
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
</div>

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
