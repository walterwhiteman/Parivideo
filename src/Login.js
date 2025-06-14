import React from 'react';

// Login.js will handle the user interface for the login screen.
// It receives props for managing room ID, user name, and initiating the join process.
function Login({ roomId, setRoomId, userName, setUserName, handleJoinRoom, myUserId, showCustomModal }) {
  return (
    <div className="login-container flex flex-col items-center justify-center min-h-[100dvh] bg-white w-full p-4 sm:p-0">
        <div className="bg-white p-10 rounded-xl shadow-xl text-center max-w-[400px] w-[90%] flex flex-col items-center gap-6 sm:p-10 sm:rounded-[15px] sm:shadow-2xl">
            <div className="app-logo bg-blue-50 rounded-full w-[100px] h-[100px] flex justify-center items-center mb-2">
                {/* Material Symbols Outlined 'person' icon */}
                <span className="material-symbols-outlined text-blue-600 text-[60px]">person</span>
            </div>
            <h1 className="app-name text-blue-600 text-5xl font-bold mb-0 sm:text-[2.5rem]">Parichat</h1>
            <p className="app-tagline text-gray-600 text-base font-medium mt-[-0.5rem] mb-6 sm:text-base">Seamlessly Connect. Chat & Video Call. Privately.</p>

            <form onSubmit={handleJoinRoom} className="login-form w-full flex flex-col space-y-4">
                <div className="input-group w-full">
                    <input
                        type="text"
                        id="roomCode"
                        placeholder="Room Code"
                        required
                        className="w-full px-5 py-4 border border-gray-200 rounded-xl text-base text-gray-900 outline-none focus:border-blue-600 transition-colors duration-300 placeholder-gray-400 sm:px-5 sm:py-4 sm:rounded-[10px] sm:text-base"
                        value={roomId}
                        onChange={(e) => setRoomId(e.target.value)}
                    />
                </div>
                <div className="input-group w-full">
                    <input
                        type="text"
                        id="userName"
                        placeholder="User Name"
                        required
                        className="w-full px-5 py-4 border border-gray-200 rounded-xl text-base text-gray-900 outline-none focus:border-blue-600 transition-colors duration-300 placeholder-gray-400 sm:px-5 sm:py-4 sm:rounded-[10px] sm:text-base"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                    />
                </div>
                <button
                    type="submit"
                    className="join-button w-full py-4 px-6 bg-blue-600 text-white border-none rounded-xl text-lg font-medium cursor-pointer uppercase tracking-wider shadow-md hover:bg-blue-700 hover:translate-y-[-2px] active:bg-blue-800 transition-all duration-300 sm:py-[1.2rem] sm:px-[1.5rem] sm:rounded-[10px] sm:text-[1.1rem] sm:font-medium sm:tracking-[0.05em]"
                >
                    JOIN ROOM
                </button>
            </form>
            <p className="text-center text-gray-500 mt-6 text-xs">
                Your anonymous ID: <span className="font-mono text-[0.6rem] select-all">{myUserId || 'N/A'}</span>
            </p>
        </div>
    </div>
  );
}

export default Login;
