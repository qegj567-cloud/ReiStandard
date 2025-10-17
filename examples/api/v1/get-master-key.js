/**
 * @type {import('next').NextApiHandler}
 */
module.exports = async (req, res) => {
  try {
    const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

    if (!vapidPublicKey) {
      console.error('VAPID public key is not configured.');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: VAPID public key is missing.',
      });
    }

    res.status(200).json({
      success: true,
      vapidPublicKey: vapidPublicKey,
    });
  } catch (error) {
    console.error('Error fetching master key:', error);
    res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};
