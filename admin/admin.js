
const config = window.NEXATRADE_SUPABASE_CONFIG;

const supabaseClient = window.supabase.createClient(
    config.url,
    config.publishableKey
);

const loginForm = document.getElementById("adminLoginForm");
const loginButton = document.getElementById("loginButton");
const loginMessage = document.getElementById("loginMessage");

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    loginButton.disabled = true;
    loginButton.textContent = "Verifying access...";
    loginMessage.textContent = "";

    try {
        // Step 1: Authenticate with Supabase.
        const { data, error } =
            await supabaseClient.auth.signInWithPassword({
                email,
                password
            });

        if (error) throw error;

        // Step 2: Verify administrator privileges on the server.
        const { data: adminData, error: adminError } =
            await supabaseClient.rpc("admin_get_settings");

        if (adminError) {
            await supabaseClient.auth.signOut();
            throw new Error(
                "Your account is not authorized as an administrator."
            );
        }

        // Step 3: Admin verification succeeded.
        loginMessage.style.color = "#57d99b";
        loginMessage.textContent =
            "Administrator verified successfully!";

        loginButton.textContent = "Opening dashboard...";
        window.location.replace("dashboard.html");

    } catch (error) {
        loginMessage.style.color = "#ff8585";
        loginMessage.textContent =
            error.message || "Login failed. Please try again.";

        loginButton.disabled = false;
        loginButton.textContent = "Sign in to dashboard";
    }
});
