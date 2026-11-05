use ironrdp::displaycontrol::client::DisplayControlClient;

fn main() {
    let display = DisplayControlClient::new(|_| Ok(Vec::new()));
    for (width, height) in [(1100, 750), (900, 600), (1200, 800)] {
        let messages = display
            .encode_single_primary_monitor(1, width, height, Some(100), Some((300, 200)))
            .expect("valid monitor layout");
        assert!(!messages.is_empty());
    }
    assert!(
        display
            .encode_single_primary_monitor(1, 199, 600, None, None)
            .is_err()
    );
    println!(
        "PASS: IronRDP compiled with graphics/session/clipboard/display-control; three resize PDUs encoded and invalid dimensions rejected."
    );
}
