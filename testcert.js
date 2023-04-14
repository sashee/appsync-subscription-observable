import forge from "node-forge";
import crypto from "node:crypto";

export const generateCert = ({altNameIPs, altNameURIs, validityDays}) => {
	const keys = forge.pki.rsa.generateKeyPair(2048);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;

	// NOTE: serialNumber is the hex encoded value of an ASN.1 INTEGER.
	// Conforming CAs should ensure serialNumber is:
	// - no more than 20 octets
	// - non-negative (prefix a '00' if your value starts with a '1' bit)
	cert.serialNumber = '01' + crypto.randomBytes(19).toString("hex"); // 1 octet = 8 bits = 1 byte = 2 hex chars
	cert.validity.notBefore = new Date();
	cert.validity.notAfter = new Date(new Date().getTime() + 1000 * 60 * 60 * 24 * (validityDays ?? 1));
	const attrs = [{
		name: 'countryName',
		value: 'AU'
	}, {
		shortName: 'ST',
		value: 'Some-State'
	}, {
		name: 'organizationName',
		value: 'Internet Widgits Pty Ltd'
	}];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);

	// add alt names so that the browser won't complain
	cert.setExtensions([{
		name: 'subjectAltName',
		altNames: [
			...(altNameURIs !== undefined ?
				altNameURIs.map((uri) => ({type: 6, value: uri})) :
				[]
			),
			...(altNameIPs !== undefined ?
				altNameIPs.map((uri) => ({type: 7, ip: uri})) :
				[]
			)
		]
	}]);
	// self-sign certificate
	cert.sign(keys.privateKey);

	// convert a Forge certificate and private key to PEM
	const pem = forge.pki.certificateToPem(cert);
	const privateKey = forge.pki.privateKeyToPem(keys.privateKey)

	return {
		cert: pem,
		privateKey
	};
}
